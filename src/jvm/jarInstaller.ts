import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { log } from '../log.js';
import { cacheJarDir } from '../workspace/paths.js';
import { findCentralMirror, findServer, loadMavenSettings } from './mavenSettings.js';

export interface MavenCoords {
  groupId: string;
  artifactId: string;
  version: string;
  classifier?: string;
  type?: string;
}

export const DEFAULT_CQL_LS_VERSION = '5.0.0';
export const DEFAULT_MAVEN_REPO = 'https://repo1.maven.org/maven2/';
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Minimum gap between onProgress callbacks; a final one is always sent. */
const PROGRESS_INTERVAL_MS = 250;
/** `.part-*` files older than this are leftovers of a dead process, not a concurrent download. */
const STALE_PART_AGE_MS = 60 * 60 * 1000;
const EXTENSION_ROOTS = ['.vscode', '.vscode-insiders', '.vscode-server', '.vscode-oss'];

export interface JarResolution {
  jarPath: string;
  downloaded: boolean;
  source: 'env' | 'cache' | 'vscode-extension' | 'download';
}

export interface JarInstallOptions {
  cacheDir?: string;
  version?: string;
  /** Explicit repository (same as CQL_LS_MAVEN_REPO). Central is never substituted for it. */
  mavenRepo?: string;
  /** Last-resort repository; defaults to Maven Central. Tests point it at a fake server. */
  centralRepo?: string;
  /** Home directory used for ~/.m2 and ~/.vscode lookups (defaults to os.homedir()). */
  homeDir?: string;
  /** Environment to read configuration and proxy settings from (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Abort a request when no bytes arrive for this long (default 60 s; env CQL_LS_DOWNLOAD_TIMEOUT_MS). */
  downloadTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (detail: { url: string; bytes: number; totalBytes?: number }) => void;
}

export interface JarAttempt {
  source: 'cache' | 'vscode-extension' | 'repo' | 'mirror' | 'central';
  target: string;
  reason: string;
}

export class JarInstallError extends Error {
  constructor(
    message: string,
    readonly detail: { url?: string; version?: string; attempts?: JarAttempt[] } = {},
  ) {
    super(message);
    this.name = 'JarInstallError';
  }
}

export function getCqlLsCoords(version: string): MavenCoords {
  return {
    groupId: 'org.opencds.cqf.cql.ls',
    artifactId: 'cql-ls-server',
    version,
  };
}

export function getLocalName(coords: MavenCoords): string {
  return `${coords.artifactId}-${coords.version}${
    coords.classifier ? '-' + coords.classifier : ''
  }${coords.type ? '.' + coords.type : '.jar'}`;
}

export function getSearchUrl(coords: MavenCoords, repoBase: string): string {
  const groupAsDir = coords.groupId.replace(/\./g, '/');
  const base = repoBase.endsWith('/') ? repoBase : repoBase + '/';
  return `${base}${groupAsDir}/${coords.artifactId}/${coords.version}/${getLocalName(coords)}`;
}

interface Repo {
  source: 'repo' | 'mirror' | 'central';
  /** Base URL with any userinfo removed. */
  base: string;
  auth?: { username: string; password: string };
}

/**
 * Resolves the language-server jar. First match wins:
 * 1. CQL_LS_JAR_PATH (run in place)
 * 2. the cql-mcp cache (run in place)
 * 3. the vscode-cql extension's jar for the same version (copied into the cache)
 * 4. CQL_LS_MAVEN_REPO, only when set
 * 5. the settings.xml mirror that matches `central`
 * 6. Maven Central, always last
 * Every failure is collected into one JarInstallError that never contains credentials.
 */
export async function ensureJar(options?: JarInstallOptions): Promise<JarResolution> {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();

  const envJar = env.CQL_LS_JAR_PATH;
  if (envJar) {
    if (!fs.existsSync(envJar)) {
      throw new JarInstallError(
        `CQL_LS_JAR_PATH points to a missing file: ${envJar}. Set it to an existing cql-ls-server jar.`,
      );
    }
    return { jarPath: envJar, downloaded: false, source: 'env' };
  }

  const version = options?.version ?? env.CQL_LS_VERSION ?? DEFAULT_CQL_LS_VERSION;
  const coords = getCqlLsCoords(version);
  const localName = getLocalName(coords);
  const cacheDir = options?.cacheDir ?? cacheJarDir(env, homeDir);
  const jarPath = path.join(cacheDir, localName);
  const attempts: JarAttempt[] = [];

  sweepStaleParts(cacheDir);

  // 2. cache
  if (fs.existsSync(jarPath)) {
    if (isValidJar(jarPath)) {
      return { jarPath, downloaded: false, source: 'cache' };
    }
    log.warn(`Cached jar is invalid (size=${safeSize(jarPath)}); removing it: ${jarPath}`);
    safeRemove(jarPath);
    attempts.push({ source: 'cache', target: jarPath, reason: 'invalid (not a jar); removed' });
  } else {
    attempts.push({ source: 'cache', target: jarPath, reason: 'not found' });
  }

  // 3. vscode-cql extension jar, copied into the cache so a VS Code update can't delete it
  const extensionJars = findExtensionJars(homeDir, localName);
  for (const candidate of extensionJars) {
    if (!isValidJar(candidate)) {
      attempts.push({ source: 'vscode-extension', target: candidate, reason: 'invalid (not a jar)' });
      continue;
    }
    try {
      copyIntoCache(candidate, jarPath);
      log.info(`Copied ${localName} from the vscode-cql extension (${candidate}) into ${cacheDir}`);
      return { jarPath, downloaded: false, source: 'vscode-extension' };
    } catch (err) {
      attempts.push({ source: 'vscode-extension', target: candidate, reason: `copy failed: ${errMessage(err)}` });
    }
  }
  if (extensionJars.length === 0) {
    attempts.push({
      source: 'vscode-extension',
      target: `~/{${EXTENSION_ROOTS.join(',')}}/extensions/cqframework.cql-*/dist/java-support/jars/${localName}`,
      reason: 'not found',
    });
  }

  // 4-6. downloads
  const secrets: string[] = [];
  const repos = buildRepos(options, env, homeDir, coords, secrets);
  const timeoutMs = options?.downloadTimeoutMs ?? (Number(env.CQL_LS_DOWNLOAD_TIMEOUT_MS) || DEFAULT_DOWNLOAD_TIMEOUT_MS);
  const dispatcher = makeDispatcher(env, timeoutMs);
  const fetchImpl = options?.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
  const proxyNote = collectProxySecrets(env, secrets);
  const redact = makeRedactor(secrets);

  try {
    for (const repo of repos) {
      const url = getSearchUrl(coords, repo.base);
      log.info(`Downloading ${localName} from ${url}`);
      try {
        await downloadJar({ url, repo, jarPath, fetchImpl, dispatcher, timeoutMs, env, proxyNote, onProgress: options?.onProgress });
        return { jarPath, downloaded: true, source: 'download' };
      } catch (err) {
        const reason = redact(describeFailure(err, url, env, proxyNote));
        log.warn(`Download of ${localName} from ${url} failed: ${reason}`);
        attempts.push({ source: repo.source, target: url, reason });
      }
    }
  } finally {
    await Promise.resolve(dispatcher.destroy()).catch(() => undefined);
  }

  throw new JarInstallError(redact(buildFailureMessage(localName, version, attempts)), {
    url: repos.length > 0 ? getSearchUrl(coords, repos[repos.length - 1].base) : undefined,
    version,
    attempts: attempts.map((a) => ({ ...a, reason: redact(a.reason), target: redact(a.target) })),
  });
}

function buildRepos(
  options: JarInstallOptions | undefined,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  coords: MavenCoords,
  secrets: string[],
): Repo[] {
  const repos: Repo[] = [];
  const seen = new Set<string>();
  const add = (repo: Repo): void => {
    const key = repo.base.replace(/\/+$/, '').toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      repos.push(repo);
    }
  };

  // 4. explicit repository, only when set. Its credentials belong to it alone.
  const explicit = options?.mavenRepo ?? env.CQL_LS_MAVEN_REPO;
  if (explicit) {
    const parsed = splitUserinfo(explicit);
    let auth = parsed.auth;
    if (env.CQL_LS_MAVEN_USERNAME && env.CQL_LS_MAVEN_PASSWORD) {
      auth = { username: env.CQL_LS_MAVEN_USERNAME, password: env.CQL_LS_MAVEN_PASSWORD };
    }
    if (auth) secrets.push(auth.password);
    add({ source: 'repo', base: parsed.base, auth });
  }

  // 5. the settings.xml mirror of central
  const settings = loadMavenSettings({ homeDir, env });
  for (const server of settings.servers) {
    if (server.password) secrets.push(server.password);
  }
  const mirror = findCentralMirror(settings);
  if (mirror) {
    const parsed = splitUserinfo(mirror.url);
    const server = findServer(settings, mirror.id);
    let auth = parsed.auth;
    if (server?.username && server.password) {
      auth = { username: server.username, password: server.password };
    }
    if (auth) secrets.push(auth.password);
    add({ source: 'mirror', base: parsed.base, auth });
  }

  // 6. Maven Central, always last
  add({ source: 'central', base: options?.centralRepo ?? DEFAULT_MAVEN_REPO });
  void coords;
  return repos;
}

/** Separates `user:password@` from a repository URL; credentials can't be sent inside the URL. */
function splitUserinfo(raw: string): { base: string; auth?: { username: string; password: string } } {
  try {
    const u = new URL(raw);
    if (!u.username && !u.password) {
      return { base: raw };
    }
    const auth = { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
    u.username = '';
    u.password = '';
    return { base: u.toString(), auth };
  } catch {
    return { base: raw };
  }
}

export function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return raw.replace(/\/\/[^/@]*@/, '//');
  }
}

function makeRedactor(secrets: string[]): (text: string) => string {
  const values = [...new Set(secrets.filter((s) => s.length > 0))]
    .flatMap((s) => [s, encodeURIComponent(s)])
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const v of values) {
      out = out.split(v).join('***');
    }
    return out.replace(/authorization:?\s*(basic|bearer)\s+\S+/gi, 'authorization: ***');
  };
}

function makeDispatcher(env: NodeJS.ProcessEnv, timeoutMs: number): EnvHttpProxyAgent {
  // Always an EnvHttpProxyAgent: it connects directly when no proxy is configured. Values come from
  // `env` explicitly so injected environments never leak in the real process.env proxy settings.
  return new EnvHttpProxyAgent({
    httpProxy: env.http_proxy ?? env.HTTP_PROXY ?? '',
    httpsProxy: env.https_proxy ?? env.HTTPS_PROXY ?? '',
    noProxy: env.no_proxy ?? env.NO_PROXY ?? '',
    // Our own stall guard is the only limiter, so a slow body is not cut off by undici's defaults.
    headersTimeout: 0,
    bodyTimeout: 0,
    connect: { timeout: timeoutMs },
  });
}

/** Collects proxy passwords (for redaction); returns a function naming the proxy used for a URL. */
function collectProxySecrets(env: NodeJS.ProcessEnv, secrets: string[]): (url: string) => string | undefined {
  for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY']) {
    const value = env[name];
    if (value) {
      const auth = splitUserinfo(value).auth;
      if (auth) secrets.push(auth.password, `${auth.username}:${auth.password}`);
    }
  }
  return (url: string) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return undefined;
    }
    const noProxy = (env.no_proxy ?? env.NO_PROXY ?? '').split(/[,\s]+/).filter(Boolean);
    const host = target.hostname.toLowerCase();
    if (noProxy.some((e) => e === '*' || host === e.replace(/^\*?\./, '').toLowerCase() || host.endsWith('.' + e.replace(/^\*?\./, '').toLowerCase()))) {
      return undefined;
    }
    const httpProxy = env.http_proxy ?? env.HTTP_PROXY;
    const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY;
    const proxy = target.protocol === 'https:' ? httpsProxy || httpProxy : httpProxy;
    return proxy ? sanitizeUrl(proxy) : undefined;
  };
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class StallError extends Error {
  constructor(ms: number) {
    super(`stalled: no data received for ${ms} ms (CQL_LS_DOWNLOAD_TIMEOUT_MS)`);
  }
}

/**
 * Aborts a request when no bytes arrive for `ms`. Reset with touch() on every chunk. The timer is
 * unref()'d and cleared by dispose(), so it never keeps the event loop alive. Racing also covers
 * readers that ignore the AbortSignal.
 */
class StallGuard {
  readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private rejectStall!: (err: Error) => void;
  private readonly stalled: Promise<never>;

  constructor(private readonly ms: number) {
    this.stalled = new Promise<never>((_resolve, reject) => {
      this.rejectStall = reject;
    });
    this.stalled.catch(() => undefined);
    this.touch();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  touch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      // Reject first: aborting makes the in-flight read fail too, and the stall must win the race.
      this.rejectStall(new StallError(this.ms));
      this.controller.abort();
    }, this.ms);
    this.timer.unref?.();
  }

  race<T>(p: Promise<T>): Promise<T> {
    return Promise.race([p, this.stalled]);
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

interface DownloadContext {
  url: string;
  repo: Repo;
  jarPath: string;
  fetchImpl: typeof fetch;
  dispatcher: EnvHttpProxyAgent;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  proxyNote: (url: string) => string | undefined;
  onProgress?: JarInstallOptions['onProgress'];
}

function authHeaders(repo: Repo): Record<string, string> {
  return repo.auth
    ? { authorization: 'Basic ' + Buffer.from(`${repo.auth.username}:${repo.auth.password}`).toString('base64') }
    : {};
}

async function guardedFetch(ctx: DownloadContext, url: string, method: string): Promise<{ res: Response; guard: StallGuard }> {
  const guard = new StallGuard(ctx.timeoutMs);
  try {
    const init = { method, headers: authHeaders(ctx.repo), dispatcher: ctx.dispatcher, signal: guard.signal };
    const res = await guard.race(ctx.fetchImpl(url, init as unknown as RequestInit));
    guard.touch();
    return { res, guard };
  } catch (err) {
    guard.dispose();
    throw err;
  }
}

async function readAllText(res: Response, guard: StallGuard): Promise<string> {
  const reader = res.body!.getReader();
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const { done, value } = await guard.race(reader.read());
      if (done) break;
      guard.touch();
      chunks.push(Buffer.from(value));
    }
  } finally {
    await Promise.resolve(reader.cancel?.()).catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function downloadJar(ctx: DownloadContext): Promise<void> {
  const { url, jarPath } = ctx;
  fs.mkdirSync(path.dirname(jarPath), { recursive: true });

  // HEAD is best effort (some mirrors reject it). A network-level failure fails the source at
  // once: the GET would only stall as well.
  let total: number | undefined;
  {
    let head: { res: Response; guard: StallGuard } | undefined;
    try {
      head = await guardedFetch(ctx, url, 'HEAD');
      if (head.res.ok) {
        const length = head.res.headers.get('content-length');
        if (length) total = parseInt(length, 10);
      }
    } finally {
      head?.guard.dispose();
    }
  }

  const part = `${jarPath}.part-${process.pid}`;
  safeRemove(part);
  let writer: fs.WriteStream | undefined;
  let writerClosed: Promise<void> | undefined;
  const { res, guard } = await guardedFetch(ctx, url, 'GET');
  try {
    if (!res.ok) {
      throw new HttpFailure(res.status, `HTTP ${res.status} ${res.statusText}`.trim());
    }
    if (!res.body) {
      throw new Error('response had no body');
    }
    const lengthHeader = res.headers.get('content-length');
    const expected = lengthHeader ? parseInt(lengthHeader, 10) : total;

    writer = fs.createWriteStream(part);
    const w = writer;
    writerClosed = new Promise<void>((resolve) => w.once('close', () => resolve()));
    const writeError = new Promise<never>((_resolve, reject) => w.once('error', reject));
    writeError.catch(() => undefined);

    const hash = createHash('sha1');
    const reader = res.body.getReader();
    let received = 0;
    let lastProgress = 0;
    try {
      for (;;) {
        const { done, value } = await guard.race(reader.read());
        if (done) break;
        guard.touch();
        received += value.byteLength;
        hash.update(value);
        await Promise.race([
          new Promise<void>((resolve, reject) => w.write(value, (err) => (err ? reject(err) : resolve()))),
          writeError,
        ]);
        const now = Date.now();
        if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
          lastProgress = now;
          ctx.onProgress?.({ url, bytes: received, totalBytes: expected ?? total });
        }
      }
    } finally {
      await Promise.resolve(reader.cancel?.()).catch(() => undefined);
    }
    ctx.onProgress?.({ url, bytes: received, totalBytes: expected ?? total });
    await new Promise<void>((resolve, reject) => w.end((err: Error | null | undefined) => (err ? reject(err) : resolve())));
    await writerClosed;

    if (expected !== undefined && received !== expected) {
      throw new Error(`size mismatch: received ${received} of ${expected} bytes`);
    }
    guard.dispose();

    await verifySha1(ctx, hash.digest('hex'));

    try {
      fs.renameSync(part, jarPath);
    } catch (err) {
      if (isValidJar(jarPath)) {
        // Another instance finished the same download first: use theirs.
        safeRemove(part);
        return;
      }
      throw new Error(`could not move the downloaded jar into place (${errCode(err)}): ${jarPath}`);
    }
  } catch (err) {
    // Close the stream before deleting: an open handle blocks the delete on Windows.
    writer?.destroy();
    await writerClosed;
    safeRemove(part);
    throw err;
  } finally {
    guard.dispose();
  }
}

async function verifySha1(ctx: DownloadContext, actual: string): Promise<void> {
  const sha1Url = `${ctx.url}.sha1`;
  const { res, guard } = await guardedFetch(ctx, sha1Url, 'GET');
  try {
    if (res.status === 404) {
      log.warn(`No .sha1 published for ${ctx.url}; skipping the integrity check`);
      return;
    }
    if (!res.ok) {
      throw new HttpFailure(res.status, `checksum file ${sanitizeUrl(sha1Url)}: HTTP ${res.status} ${res.statusText}`.trim());
    }
    const body = (await readAllText(res, guard)).trim();
    const match = /^([0-9a-f]{40})\b/i.exec(body);
    if (!match) {
      throw new Error(`checksum file ${sanitizeUrl(sha1Url)} does not contain a SHA-1`);
    }
    if (match[1].toLowerCase() !== actual) {
      throw new Error(`SHA-1 mismatch (expected ${match[1].toLowerCase()}, got ${actual})`);
    }
  } finally {
    guard.dispose();
  }
}

function describeFailure(err: unknown, url: string, env: NodeJS.ProcessEnv, proxyNote: (url: string) => string | undefined): string {
  if (err instanceof HttpFailure || err instanceof StallError) {
    return err.message;
  }
  let reason = errMessage(err);
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  if (cause && (cause.code || cause.message)) {
    reason = `${cause.code ? cause.code + ': ' : ''}${cause.message ?? ''}`.trim();
  }
  const networkLevel = err instanceof TypeError || !!cause;
  const proxy = networkLevel ? proxyNote(url) : undefined;
  void env;
  return proxy ? `${reason} (via proxy ${proxy})` : reason;
}

function buildFailureMessage(localName: string, version: string, attempts: JarAttempt[]): string {
  const lines = attempts.map((a) => `  - ${a.source} ${a.target}: ${a.reason}`);
  let msg = `Could not obtain ${localName}. Tried:\n${lines.join('\n')}`;
  if (attempts.some((a) => a.reason.startsWith('HTTP 404'))) {
    msg +=
      `\nHint: SNAPSHOT artifacts are not published to Maven Central.` +
      `\n  - For a local SNAPSHOT jar, set CQL_LS_JAR_PATH=<path-to-jar>.` +
      `\n  - For a released version, set CQL_LS_VERSION=<x.y.z> (e.g. ${DEFAULT_CQL_LS_VERSION}).`;
  }
  void version;
  return msg;
}

/** vscode-cql jars for exactly this version, newest extension folder first within each root. */
function findExtensionJars(homeDir: string, localName: string): string[] {
  const found: string[] = [];
  for (const root of EXTENSION_ROOTS) {
    const extensionsDir = path.join(homeDir, root, 'extensions');
    let entries: string[];
    try {
      entries = fs.readdirSync(extensionsDir);
    } catch {
      continue;
    }
    const folders = entries.filter((e) => e.startsWith('cqframework.cql-')).sort().reverse();
    for (const folder of folders) {
      const jar = path.join(extensionsDir, folder, 'dist', 'java-support', 'jars', localName);
      if (fs.existsSync(jar)) {
        found.push(jar);
      }
    }
  }
  return found;
}

function copyIntoCache(src: string, jarPath: string): void {
  fs.mkdirSync(path.dirname(jarPath), { recursive: true });
  const part = `${jarPath}.part-${process.pid}`;
  try {
    fs.copyFileSync(src, part);
    try {
      fs.renameSync(part, jarPath);
    } catch (err) {
      if (!isValidJar(jarPath)) {
        throw new Error(`could not move the copied jar into place (${errCode(err)}): ${jarPath}`);
      }
      // another instance copied it first
    }
  } finally {
    safeRemove(part);
  }
}

/** Best-effort removal of `*.part-*` files left by dead processes (older than an hour). */
function sweepStaleParts(cacheDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_PART_AGE_MS;
  for (const entry of entries) {
    if (!/\.part-\d+$/.test(entry)) continue;
    const file = path.join(cacheDir, entry);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        safeRemove(file);
      }
    } catch {
      // gone already
    }
  }
}

/** Deletes a file, logging instead of throwing (a locked file on Windows must not fail startup). */
export function safeRemove(file: string): void {
  try {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (err) {
    log.warn(`Could not remove ${file}: ${errCode(err)}`);
  }
}

function safeSize(file: string): number | string {
  try {
    return fs.statSync(file).size;
  } catch {
    return 'unknown';
  }
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? errMessage(err);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Minimal JAR integrity check: file must be non-empty and start with the ZIP
 * local-file-header magic bytes (PK\003\004). Catches partial downloads,
 * 0-byte files, and non-jar content that has been dropped into the cache.
 */
function isValidJar(jarPath: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(jarPath, 'r');
  } catch {
    return false;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size < 4) {
      return false;
    }
    const buf = Buffer.alloc(4);
    const read = fs.readSync(fd, buf, 0, 4, 0);
    if (read < 4) {
      return false;
    }
    return buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  } finally {
    fs.closeSync(fd);
  }
}

