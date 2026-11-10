import * as fs from 'node:fs';
import * as path from 'node:path';
import { cacheJarDir } from '../workspace/paths.js';

export interface MavenCoords {
  groupId: string;
  artifactId: string;
  version: string;
  classifier?: string;
  type?: string;
}

export const DEFAULT_CQL_LS_VERSION = '5.0.0';
export const DEFAULT_MAVEN_REPO = 'https://repo1.maven.org/maven2/';

export interface JarResolution {
  jarPath: string;
  downloaded: boolean;
  source: 'env' | 'cache' | 'download';
}

export interface JarInstallOptions {
  cacheDir?: string;
  version?: string;
  mavenRepo?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (detail: { received: number; total?: number }) => void;
}

export class JarInstallError extends Error {
  constructor(
    message: string,
    readonly detail: { url?: string; version?: string } = {},
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

export async function ensureJar(options?: JarInstallOptions): Promise<JarResolution> {
  const envJar = process.env.CQL_LS_JAR_PATH;
  if (envJar) {
    if (!fs.existsSync(envJar)) {
      throw new JarInstallError(
        `CQL_LS_JAR_PATH points to a missing file: ${envJar}. Set it to an existing cql-ls-server jar.`,
      );
    }
    return { jarPath: envJar, downloaded: false, source: 'env' };
  }

  const version = options?.version ?? process.env.CQL_LS_VERSION ?? DEFAULT_CQL_LS_VERSION;
  const repoBase = options?.mavenRepo ?? process.env.CQL_LS_MAVEN_REPO ?? DEFAULT_MAVEN_REPO;
  const cacheDir = options?.cacheDir ?? cacheJarDir();
  const coords = getCqlLsCoords(version);
  const jarPath = path.join(cacheDir, getLocalName(coords));

  if (fs.existsSync(jarPath) && isValidJar(jarPath)) {
    return { jarPath, downloaded: false, source: 'cache' };
  }
  if (fs.existsSync(jarPath)) {
    console.warn(
      `[jarInstaller] Cached jar is invalid (size=${fs.statSync(jarPath).size}); removing and re-downloading: ${jarPath}`,
    );
    fs.unlinkSync(jarPath);
  }

  await installJar(coords, repoBase, jarPath, options);
  return { jarPath, downloaded: true, source: 'download' };
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

async function installJar(
  coords: MavenCoords,
  repoBase: string,
  jarPath: string,
  options?: JarInstallOptions,
): Promise<void> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  const url = getSearchUrl(coords, repoBase);
  const cacheDir = path.dirname(jarPath);
  fs.mkdirSync(cacheDir, { recursive: true });

  let total: number | undefined;
  try {
    const head = await fetchImpl(url, { method: 'HEAD' });
    if (head.ok) {
      const length = head.headers.get('content-length');
      if (length) {
        total = parseInt(length, 10);
      }
    }
  } catch {
    // HEAD is best-effort; some mirrors reject it.
  }

  const res = await fetchImpl(url);
  if (!res.ok) {
    let msg = `Failed to download ${coords.artifactId}: HTTP ${res.status} ${res.statusText}`;
    if (res.status === 404) {
      msg +=
        `\nHint: SNAPSHOT artifacts are not published to Maven Central.` +
        `\n  - For a local SNAPSHOT jar, set CQL_LS_JAR_PATH=<path-to-jar>.` +
        `\n  - For a released version, set CQL_LS_VERSION=<x.y.z> (e.g. ${DEFAULT_CQL_LS_VERSION}).`;
    }
    throw new JarInstallError(msg, { url, version: coords.version });
  }
  if (!res.body) {
    throw new JarInstallError(`Download response had no body`, { url, version: coords.version });
  }

  const partPath = `${jarPath}.part`;
  try {
    const writer = fs.createWriteStream(partPath);
    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      await new Promise<void>((resolve, reject) => {
        writer.write(value, (err) => (err ? reject(err) : resolve()));
      });
      options?.onProgress?.({ received, total });
    }
    await new Promise<void>((resolve, reject) => {
      writer.end((err: Error | null) => (err ? reject(err) : resolve()));
    });
    fs.renameSync(partPath, jarPath);
  } catch (err: unknown) {
    if (fs.existsSync(partPath)) {
      fs.unlinkSync(partPath);
    }
    if (err instanceof JarInstallError) {
      throw err;
    }
    throw new JarInstallError(`Failed to install ${coords.artifactId}: ${String(err)}`, {
      url,
      version: coords.version,
    });
  }
}