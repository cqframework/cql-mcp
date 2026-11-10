import { expect } from 'chai';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EnvHttpProxyAgent } from 'undici';
import {
  DEFAULT_CQL_LS_VERSION,
  DEFAULT_MAVEN_REPO,
  ensureJar,
  getCqlLsCoords,
  getLocalName,
  getSearchUrl,
  JarInstallError,
} from '../../../src/jvm/jarInstaller.js';
import type { JarInstallOptions } from '../../../src/jvm/jarInstaller.js';
import { configureLog } from '../../../src/log.js';

const ORIGINAL_ENV = { ...process.env };
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const CENTRAL = 'https://central.test/maven2/';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cql-jar-'));
}

// ---- fake fetch -----------------------------------------------------------------------------

interface FakeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  body: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel?: () => Promise<void> } } | null;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  dispatcher: unknown;
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 401: 'Unauthorized', 404: 'Not Found', 405: 'Method Not Allowed', 500: 'Internal Server Error' };

function reply(status: number, body: Uint8Array | null, opts: { contentLength?: number; failAfterFirstRead?: boolean; stall?: boolean } = {}): FakeResponse {
  let reads = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: STATUS_TEXT[status] ?? 'Error',
    headers: {
      get: (name) =>
        name.toLowerCase() === 'content-length' && body ? String(opts.contentLength ?? body.byteLength) : null,
    },
    body: body
      ? {
          getReader: () => ({
            read: async () => {
              if (opts.stall) {
                return new Promise<never>(() => undefined); // never settles
              }
              reads += 1;
              if (opts.failAfterFirstRead && reads === 2) {
                throw new Error('simulated stream failure');
              }
              return reads === 1 ? { done: false, value: body } : { done: true };
            },
            cancel: async () => undefined,
          }),
        }
      : null,
  };
}

const sha1Hex = (content: Uint8Array): string => createHash('sha1').update(content).digest('hex');

type Router = (url: string, method: string, headers: Record<string, string>) => FakeResponse | Promise<FakeResponse>;

function fakeFetch(router: Router): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: { method?: string; headers?: Record<string, string>; dispatcher?: unknown }) => {
    const call = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, dispatcher: init?.dispatcher };
    calls.push(call);
    return router(call.url, call.method, call.headers);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Serves `content` for the jar (HEAD and GET) and a matching .sha1 under `base`. */
function repoServing(base: string, version: string, content: Uint8Array, sha1: 'ok' | 'none' | string = 'ok'): Router {
  const jar = getSearchUrl(getCqlLsCoords(version), base);
  return (url, method) => {
    if (url === jar) return reply(200, method === 'HEAD' ? null : content);
    if (url === `${jar}.sha1`) {
      if (sha1 === 'none') return reply(404, null);
      const text = sha1 === 'ok' ? sha1Hex(content) : sha1;
      return reply(200, new TextEncoder().encode(text));
    }
    return reply(404, null);
  };
}

function jarUrl(base: string, version: string): string {
  return getSearchUrl(getCqlLsCoords(version), base);
}

function settingsXml(body: string): string {
  return `<settings>${body}</settings>`;
}

interface Sandbox {
  home: string;
  cache: string;
  env: NodeJS.ProcessEnv;
  options: (extra?: JarInstallOptions) => JarInstallOptions;
}

function sandbox(version: string, extraEnv: NodeJS.ProcessEnv = {}): Sandbox {
  const home = tempDir();
  const cache = path.join(home, 'cache');
  const env: NodeJS.ProcessEnv = { CQL_LS_VERSION: version, CQL_MCP_JAR_DIR: cache, ...extraEnv };
  return {
    home,
    cache,
    env,
    options: (extra = {}) => ({ homeDir: home, env, centralRepo: CENTRAL, ...extra }),
  };
}

function writeSettings(home: string, xml: string): void {
  fs.mkdirSync(path.join(home, '.m2'), { recursive: true });
  fs.writeFileSync(path.join(home, '.m2', 'settings.xml'), xml);
}

function writeExtensionJar(home: string, folder: string, version: string, content: Buffer, root = '.vscode'): string {
  const dir = path.join(home, root, 'extensions', folder, 'dist', 'java-support', 'jars');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cql-ls-server-${version}.jar`);
  fs.writeFileSync(file, content);
  return file;
}

function activeTimers(): number {
  return (process as unknown as { getActiveResourcesInfo(): string[] }).getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
}

describe('jvm/jarInstaller', () => {
  const dirs: string[] = [];
  const sb = (version: string, extraEnv: NodeJS.ProcessEnv = {}): Sandbox => {
    const s = sandbox(version, extraEnv);
    dirs.push(s.home);
    return s;
  };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    while (dirs.length) {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  describe('coordinate helpers', () => {
    it('builds the local jar name with version', () => {
      expect(getLocalName(getCqlLsCoords('4.11.0-SNAPSHOT'))).to.equal('cql-ls-server-4.11.0-SNAPSHOT.jar');
    });

    it('defaults to a released (non-SNAPSHOT) version resolvable on Maven Central', () => {
      expect(DEFAULT_CQL_LS_VERSION.endsWith('-SNAPSHOT')).to.equal(false);
      expect(DEFAULT_CQL_LS_VERSION).to.match(/^\d+\.\d+\.\d+$/);
    });

    it('defaults to LS 5.0.0', () => {
      expect(DEFAULT_CQL_LS_VERSION).to.equal('5.0.0');
    });

    it('builds a maven2-style URL', () => {
      const url = getSearchUrl(getCqlLsCoords('1.2.3'), 'https://repo1.maven.org/maven2/');
      expect(url).to.equal(
        'https://repo1.maven.org/maven2/org/opencds/cqf/cql/ls/cql-ls-server/1.2.3/cql-ls-server-1.2.3.jar',
      );
    });

    it('appends a trailing slash when the repo base lacks one', () => {
      const url = getSearchUrl(getCqlLsCoords('1.2.3'), 'https://repo.example.com/maven2');
      expect(url.startsWith('https://repo.example.com/maven2/org/opencds/')).to.equal(true);
    });
  });

  describe('resolution order (one test per source)', () => {
    it('1. CQL_LS_JAR_PATH is returned unchanged when it exists', async () => {
      const s = sb('9.9.9', { CQL_LS_JAR_PATH: '' });
      const jar = path.join(s.home, 'local.jar');
      fs.writeFileSync(jar, 'fake');
      s.env.CQL_LS_JAR_PATH = jar;
      expect(await ensureJar(s.options())).to.deep.equal({ jarPath: jar, downloaded: false, source: 'env' });
    });

    it('1b. throws a structured JarInstallError when the env jar is missing', async () => {
      process.env.CQL_LS_JAR_PATH = '/does/not/exist/cql-ls-server.jar';
      try {
        await ensureJar();
        expect.fail('expected ensureJar to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(JarInstallError);
        expect((err as JarInstallError).message).to.include('CQL_LS_JAR_PATH');
      }
    });

    it('2. a valid cached jar is used in place, without any request', async () => {
      const s = sb('9.9.9');
      fs.mkdirSync(s.cache, { recursive: true });
      const jarPath = path.join(s.cache, 'cql-ls-server-9.9.9.jar');
      fs.writeFileSync(jarPath, ZIP);
      const { fetchImpl, calls } = fakeFetch(() => reply(500, null));
      const result = await ensureJar(s.options({ fetchImpl }));
      expect(result).to.deep.equal({ jarPath, downloaded: false, source: 'cache' });
      expect(calls).to.have.length(0);
    });

    it('3. the vscode-cql extension jar is copied into the cache and run from there', async () => {
      const s = sb('9.9.9');
      const content = Buffer.concat([ZIP, Buffer.from('extension-jar')]);
      const src = writeExtensionJar(s.home, 'cqframework.cql-0.8.0', '9.9.9', content);
      const { fetchImpl, calls } = fakeFetch(() => reply(500, null));
      const result = await ensureJar(s.options({ fetchImpl }));
      const jarPath = path.join(s.cache, 'cql-ls-server-9.9.9.jar');
      expect(result).to.deep.equal({ jarPath, downloaded: false, source: 'vscode-extension' });
      expect(fs.readFileSync(jarPath).equals(content)).to.equal(true);
      expect(fs.existsSync(src)).to.equal(true); // the extension's own copy is untouched
      expect(fs.readdirSync(s.cache).filter((f) => f.includes('.part'))).to.deep.equal([]);
      expect(calls).to.have.length(0);
    });

    it('3b. only an exact version match is used from the extension', async () => {
      const s = sb('9.9.9');
      writeExtensionJar(s.home, 'cqframework.cql-0.8.0', '5.0.0', ZIP);
      const { fetchImpl } = fakeFetch(repoServing(CENTRAL, '9.9.9', Buffer.concat([ZIP, Buffer.from('x')])));
      const result = await ensureJar(s.options({ fetchImpl }));
      expect(result.source).to.equal('download');
    });

    it('3c. an invalid jar in the first cqframework.cql-* folder is skipped for a valid one in a second', async () => {
      const s = sb('9.9.9');
      writeExtensionJar(s.home, 'cqframework.cql-0.8.0', '9.9.9', Buffer.from('truncated, not a jar'));
      const good = Buffer.concat([ZIP, Buffer.from('good')]);
      writeExtensionJar(s.home, 'cqframework.cql-0.7.7', '9.9.9', good);
      const result = await ensureJar(s.options());
      expect(result.source).to.equal('vscode-extension');
      expect(fs.readFileSync(result.jarPath).equals(good)).to.equal(true);
    });

    it('3d. other VS Code flavours are searched (.vscode-server)', async () => {
      const s = sb('9.9.9');
      writeExtensionJar(s.home, 'cqframework.cql-0.8.0', '9.9.9', ZIP, '.vscode-server');
      expect((await ensureJar(s.options())).source).to.equal('vscode-extension');
    });

    it('3e. the cache wins over the extension', async () => {
      const s = sb('9.9.9');
      writeExtensionJar(s.home, 'cqframework.cql-0.8.0', '9.9.9', ZIP);
      fs.mkdirSync(s.cache, { recursive: true });
      fs.writeFileSync(path.join(s.cache, 'cql-ls-server-9.9.9.jar'), ZIP);
      expect((await ensureJar(s.options())).source).to.equal('cache');
    });

    it('a jar in ~/.m2/repository is NOT used (ADR-0001: no local Maven repository)', async () => {
      const s = sb('9.9.9');
      const m2 = path.join(s.home, '.m2', 'repository', 'org', 'opencds', 'cqf', 'cql', 'ls', 'cql-ls-server', '9.9.9');
      fs.mkdirSync(m2, { recursive: true });
      fs.writeFileSync(path.join(m2, 'cql-ls-server-9.9.9.jar'), ZIP);
      const { fetchImpl, calls } = fakeFetch(() => reply(404, null));
      let error: Error | null = null;
      try {
        await ensureJar(s.options({ fetchImpl }));
      } catch (err) {
        error = err as Error;
      }
      expect(error).to.be.instanceOf(JarInstallError);
      expect(calls.length).to.be.greaterThan(0); // it went to the network instead
      expect(fs.existsSync(path.join(s.cache, 'cql-ls-server-9.9.9.jar'))).to.equal(false);
    });

    it('6. downloads from Central into the cache as the last source', async () => {
      const s = sb('9.9.9');
      const content = Buffer.concat([ZIP, Buffer.from('central-jar')]);
      const { fetchImpl } = fakeFetch(repoServing(CENTRAL, '9.9.9', content));
      let bytes = 0;
      const result = await ensureJar(s.options({ fetchImpl, onProgress: (d) => (bytes = d.bytes) }));
      const jarPath = path.join(s.cache, 'cql-ls-server-9.9.9.jar');
      expect(result).to.deep.equal({ jarPath, downloaded: true, source: 'download' });
      expect(fs.readFileSync(jarPath).equals(content)).to.equal(true);
      expect(bytes).to.equal(content.length);
      expect(fs.readdirSync(s.cache).filter((f) => f.includes('.part'))).to.deep.equal([]);
    });

    it('uses the real Maven Central URL by default', async () => {
      const s = sb('1.0.0');
      const { fetchImpl, calls } = fakeFetch(() => reply(404, null));
      await ensureJar({ homeDir: s.home, env: s.env, fetchImpl }).catch(() => undefined);
      expect(calls[0].url).to.equal(jarUrl(DEFAULT_MAVEN_REPO, '1.0.0'));
    });

    it('re-downloads when the cached jar is empty or not a jar, and removes the bad file first', async () => {
      for (const bad of ['', 'this is not a jar file at all']) {
        const s = sb('1.2.3');
        fs.mkdirSync(s.cache, { recursive: true });
        fs.writeFileSync(path.join(s.cache, 'cql-ls-server-1.2.3.jar'), bad);
        const { fetchImpl } = fakeFetch(repoServing(CENTRAL, '1.2.3', Buffer.concat([ZIP, Buffer.from('ok')])));
        const result = await ensureJar(s.options({ fetchImpl }));
        expect(result.source).to.equal('download');
      }
    });
  });

  describe('download order and aggregated errors', () => {
    const REPO = 'https://repo.corp.test/maven/';
    const MIRROR = 'https://mirror.corp.test/central/';

    function mirrorSettings(mirrorOf = '*'): string {
      return settingsXml(
        `<mirrors><mirror><id>corp</id><url>${MIRROR}</url><mirrorOf>${mirrorOf}</mirrorOf></mirror></mirrors>` +
          `<servers><server><id>corp</id><username>alice</username><password>mirror-pw</password></server></servers>`,
      );
    }

    it('falls back from CQL_LS_MAVEN_REPO to the mirror to Central, in that order', async () => {
      const s = sb('9.9.9', { CQL_LS_MAVEN_REPO: REPO });
      writeSettings(s.home, mirrorSettings());
      const content = Buffer.concat([ZIP, Buffer.from('c')]);
      const central = repoServing(CENTRAL, '9.9.9', content);
      const { fetchImpl, calls } = fakeFetch((url, method, headers) => {
        if (url.startsWith(REPO)) return reply(404, null);
        if (url.startsWith(MIRROR)) return reply(500, null);
        return central(url, method, headers);
      });
      const result = await ensureJar(s.options({ fetchImpl }));
      expect(result.source).to.equal('download');
      const jarCalls = calls.filter((c) => c.method === 'GET' && c.url.endsWith('.jar')).map((c) => c.url);
      expect(jarCalls).to.deep.equal([jarUrl(REPO, '9.9.9'), jarUrl(MIRROR, '9.9.9'), jarUrl(CENTRAL, '9.9.9')]);
    });

    it('with no CQL_LS_MAVEN_REPO the mirror is tried before Central, and Central is still tried last', async () => {
      const s = sb('9.9.9');
      writeSettings(s.home, mirrorSettings());
      const { fetchImpl, calls } = fakeFetch(() => reply(404, null));
      await ensureJar(s.options({ fetchImpl })).catch(() => undefined);
      const jarCalls = calls.filter((c) => c.method === 'GET').map((c) => c.url);
      expect(jarCalls).to.deep.equal([jarUrl(MIRROR, '9.9.9'), jarUrl(CENTRAL, '9.9.9')]);
    });

    it('does not try Central ahead of the mirror when CQL_LS_MAVEN_REPO is unset', async () => {
      const s = sb('9.9.9');
      writeSettings(s.home, mirrorSettings());
      const { fetchImpl, calls } = fakeFetch(repoServing(MIRROR, '9.9.9', ZIP));
      const result = await ensureJar(s.options({ fetchImpl }));
      expect(result.source).to.equal('download');
      expect(calls.some((c) => c.url.startsWith(CENTRAL))).to.equal(false);
    });

    it('skips a mirror whose mirrorOf excludes central', async () => {
      const s = sb('9.9.9');
      writeSettings(s.home, mirrorSettings('*,!central'));
      const { fetchImpl, calls } = fakeFetch(repoServing(CENTRAL, '9.9.9', ZIP));
      await ensureJar(s.options({ fetchImpl }));
      expect(calls.some((c) => c.url.startsWith(MIRROR))).to.equal(false);
    });

    it('tries a URL only once when sources coincide', async () => {
      const s = sb('9.9.9', { CQL_LS_MAVEN_REPO: CENTRAL });
      const { fetchImpl, calls } = fakeFetch(() => reply(404, null));
      await ensureJar(s.options({ fetchImpl })).catch(() => undefined);
      expect(calls.filter((c) => c.method === 'GET' && c.url.endsWith('.jar'))).to.have.length(1);
    });

    it('reports one aggregated error listing every path and URL with its reason, and no credentials', async () => {
      const s = sb('9.9.9', {
        CQL_LS_MAVEN_REPO: 'https://bob:url-secret@repo.corp.test/maven/',
        CQL_LS_MAVEN_USERNAME: 'carol',
        CQL_LS_MAVEN_PASSWORD: 'env-secret',
      });
      writeSettings(s.home, mirrorSettings());
      const { fetchImpl } = fakeFetch((url) => (url.startsWith(MIRROR) ? reply(401, null) : reply(404, null)));
      let error: JarInstallError | null = null;
      try {
        await ensureJar(s.options({ fetchImpl }));
      } catch (err) {
        error = err as JarInstallError;
      }
      expect(error).to.be.instanceOf(JarInstallError);
      const msg = error!.message;
      expect(msg).to.include(path.join(s.cache, 'cql-ls-server-9.9.9.jar'));
      expect(msg).to.include('vscode-extension');
      expect(msg).to.include(jarUrl('https://repo.corp.test/maven/', '9.9.9')).and.to.include('HTTP 404');
      expect(msg).to.include(jarUrl(MIRROR, '9.9.9')).and.to.include('HTTP 401');
      expect(msg).to.include(jarUrl(CENTRAL, '9.9.9'));
      expect(msg).to.include('SNAPSHOT'); // the 404 hint is kept
      for (const secret of ['url-secret', 'env-secret', 'mirror-pw', 'bob:', 'carol']) {
        expect(msg, `message must not contain ${secret}`).to.not.include(secret);
      }
      expect(JSON.stringify(error!.detail)).to.not.include('secret');
      expect(error!.detail.attempts!.length).to.be.greaterThan(3);
    });

    it('sends Basic auth only to the repo the credentials belong to', async () => {
      const s = sb('9.9.9', { CQL_LS_MAVEN_REPO: REPO });
      writeSettings(s.home, mirrorSettings());
      const { fetchImpl, calls } = fakeFetch(() => reply(404, null));
      await ensureJar(s.options({ fetchImpl })).catch(() => undefined);
      const byHost = (prefix: string) => calls.filter((c) => c.url.startsWith(prefix));
      expect(byHost(REPO).every((c) => c.headers.authorization === undefined)).to.equal(true); // no creds for REPO
      const mirrorCalls = byHost(MIRROR);
      expect(mirrorCalls.length).to.be.greaterThan(0);
      for (const c of mirrorCalls) {
        expect(c.headers.authorization).to.equal('Basic ' + Buffer.from('alice:mirror-pw').toString('base64'));
      }
      expect(byHost(CENTRAL).every((c) => c.headers.authorization === undefined)).to.equal(true);
    });

    it('takes CQL_LS_MAVEN_USERNAME/PASSWORD for CQL_LS_MAVEN_REPO only', async () => {
      const s = sb('9.9.9', { CQL_LS_MAVEN_REPO: REPO, CQL_LS_MAVEN_USERNAME: 'u', CQL_LS_MAVEN_PASSWORD: 'p' });
      const { fetchImpl, calls } = fakeFetch(() => reply(404, null));
      await ensureJar(s.options({ fetchImpl })).catch(() => undefined);
      expect(calls.filter((c) => c.url.startsWith(REPO)).every((c) => c.headers.authorization !== undefined)).to.equal(true);
      expect(calls.filter((c) => c.url.startsWith(CENTRAL)).every((c) => c.headers.authorization === undefined)).to.equal(true);
    });

    it('moves URL userinfo into a Basic header and never puts it in the request URL', async () => {
      const s = sb('9.9.9', { CQL_LS_MAVEN_REPO: 'https://bob:p%40ss@repo.corp.test/maven/' });
      const { fetchImpl, calls } = fakeFetch(() => reply(404, null));
      await ensureJar(s.options({ fetchImpl })).catch(() => undefined);
      const first = calls[0];
      expect(first.url).to.not.include('bob').and.to.not.include('@');
      expect(first.headers.authorization).to.equal('Basic ' + Buffer.from('bob:p@ss').toString('base64'));
    });

    it('always passes the EnvHttpProxyAgent dispatcher to fetch', async () => {
      const s = sb('9.9.9');
      const { fetchImpl, calls } = fakeFetch(repoServing(CENTRAL, '9.9.9', ZIP));
      await ensureJar(s.options({ fetchImpl }));
      expect(calls.length).to.be.greaterThan(1);
      for (const c of calls) {
        expect(c.dispatcher).to.be.instanceOf(EnvHttpProxyAgent);
      }
    });
  });

  describe('integrity and robustness', () => {
    const content = Buffer.concat([ZIP, Buffer.from('payload')]);

    it('accepts a matching SHA-1', async () => {
      const s = sb('9.9.9');
      const { fetchImpl } = fakeFetch(repoServing(CENTRAL, '9.9.9', content, 'ok'));
      expect((await ensureJar(s.options({ fetchImpl }))).source).to.equal('download');
    });

    it('accepts a .sha1 body with a "  filename\\n" suffix', async () => {
      const s = sb('9.9.9');
      const { fetchImpl } = fakeFetch(repoServing(CENTRAL, '9.9.9', content, `${sha1Hex(content)}  cql-ls-server-9.9.9.jar\n`));
      expect((await ensureJar(s.options({ fetchImpl }))).source).to.equal('download');
    });

    it('a SHA-1 mismatch fails that source and moves to the next, leaving no .part file', async () => {
      const bad = 'a'.repeat(40);
      const s = sb('9.9.9', { CQL_LS_MAVEN_REPO: 'https://repo.corp.test/maven/' });
      const goodCentral = repoServing(CENTRAL, '9.9.9', content);
      const badRepo = repoServing('https://repo.corp.test/maven/', '9.9.9', content, bad);
      const { fetchImpl } = fakeFetch((url, m, h) => (url.startsWith(CENTRAL) ? goodCentral(url, m, h) : badRepo(url, m, h)));
      const result = await ensureJar(s.options({ fetchImpl }));
      expect(result.source).to.equal('download');
      expect(fs.readdirSync(s.cache).filter((f) => f.includes('.part'))).to.deep.equal([]);
    });

    it('a SHA-1 mismatch on the only source is an error naming the mismatch', async () => {
      const s = sb('9.9.9');
      const { fetchImpl } = fakeFetch(repoServing(CENTRAL, '9.9.9', content, 'b'.repeat(40)));
      try {
        await ensureJar(s.options({ fetchImpl }));
        expect.fail('expected a throw');
      } catch (err) {
        expect((err as Error).message).to.include('SHA-1 mismatch');
      }
      expect(fs.existsSync(path.join(s.cache, 'cql-ls-server-9.9.9.jar'))).to.equal(false);
    });

    it('a 404 for .sha1 means "unpublished": warn and accept', async () => {
      const s = sb('9.9.9');
      const { fetchImpl } = fakeFetch(repoServing(CENTRAL, '9.9.9', content, 'none'));
      expect((await ensureJar(s.options({ fetchImpl }))).source).to.equal('download');
    });

    it('a 500 for .sha1 fails that source', async () => {
      const s = sb('9.9.9');
      const jar = jarUrl(CENTRAL, '9.9.9');
      const { fetchImpl } = fakeFetch((url, method) => {
        if (url === jar) return reply(200, method === 'HEAD' ? null : content);
        return reply(500, null);
      });
      try {
        await ensureJar(s.options({ fetchImpl }));
        expect.fail('expected a throw');
      } catch (err) {
        expect((err as Error).message).to.include('HTTP 500');
      }
      expect(fs.existsSync(path.join(s.cache, 'cql-ls-server-9.9.9.jar'))).to.equal(false);
    });

    it('rejects a body that does not match content-length', async () => {
      const s = sb('9.9.9');
      const jar = jarUrl(CENTRAL, '9.9.9');
      const { fetchImpl } = fakeFetch((url, method) =>
        url === jar ? reply(200, method === 'HEAD' ? null : content, { contentLength: content.length + 100 }) : reply(404, null),
      );
      try {
        await ensureJar(s.options({ fetchImpl }));
        expect.fail('expected a throw');
      } catch (err) {
        expect((err as Error).message).to.include('size mismatch');
      }
      expect(fs.readdirSync(s.cache).filter((f) => f.includes('.part'))).to.deep.equal([]);
    });

    it('cleans up the partial file when the stream fails mid-download', async () => {
      const s = sb('9.9.9');
      const jar = jarUrl(CENTRAL, '9.9.9');
      const { fetchImpl } = fakeFetch((url, method) =>
        url === jar ? reply(200, method === 'HEAD' ? null : content, { failAfterFirstRead: true }) : reply(404, null),
      );
      try {
        await ensureJar(s.options({ fetchImpl }));
        expect.fail('expected a throw');
      } catch (err) {
        expect(err).to.be.instanceOf(JarInstallError);
        expect((err as Error).message).to.include('simulated stream failure');
      }
      expect(fs.readdirSync(s.cache).filter((f) => f.includes('.part'))).to.deep.equal([]);
    });

    it('stall timeout: a body that stops delivering bytes fails the source, and no timer is left running', async () => {
      const s = sb('9.9.9');
      const jar = jarUrl(CENTRAL, '9.9.9');
      await new Promise((resolve) => setImmediate(resolve)); // let mocha arm its own test timer first
      const before = activeTimers();
      const { fetchImpl } = fakeFetch((url, method) =>
        url === jar ? reply(200, method === 'HEAD' ? null : content, { stall: true }) : reply(404, null),
      );
      const started = Date.now();
      try {
        await ensureJar(s.options({ fetchImpl, downloadTimeoutMs: 80 }));
        expect.fail('expected a throw');
      } catch (err) {
        expect((err as Error).message).to.include('stalled');
      }
      expect(Date.now() - started).to.be.lessThan(2000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(activeTimers()).to.be.at.most(before);
      expect(fs.readdirSync(s.cache).filter((f) => f.includes('.part'))).to.deep.equal([]);
    });

    it('reads the stall timeout from CQL_LS_DOWNLOAD_TIMEOUT_MS', async () => {
      const s = sb('9.9.9', { CQL_LS_DOWNLOAD_TIMEOUT_MS: '60' });
      const jar = jarUrl(CENTRAL, '9.9.9');
      const { fetchImpl } = fakeFetch((url, method) =>
        url === jar ? reply(200, method === 'HEAD' ? null : content, { stall: true }) : reply(404, null),
      );
      try {
        await ensureJar(s.options({ fetchImpl }));
        expect.fail('expected a throw');
      } catch (err) {
        expect((err as Error).message).to.include('stalled: no data received for 60 ms');
      }
    });

    it('HEAD rejected (405) still downloads', async () => {
      const s = sb('9.9.9');
      const jar = jarUrl(CENTRAL, '9.9.9');
      const { fetchImpl } = fakeFetch((url, method) => {
        if (method === 'HEAD') return reply(405, null);
        return url === jar ? reply(200, content) : reply(404, null);
      });
      expect((await ensureJar(s.options({ fetchImpl }))).source).to.equal('download');
    });

    it('an EBUSY while deleting a bad cached jar does not fail startup', async () => {
      const s = sb('9.9.9');
      fs.mkdirSync(s.cache, { recursive: true });
      const bad = path.join(s.cache, 'cql-ls-server-9.9.9.jar');
      fs.writeFileSync(bad, 'not a jar');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const realFs = require('node:fs') as typeof fs;
      const realUnlink = realFs.unlinkSync;
      realFs.unlinkSync = ((file: fs.PathLike) => {
        if (String(file) === bad) {
          throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
        }
        return realUnlink(file);
      }) as typeof fs.unlinkSync;
      try {
        const { fetchImpl } = fakeFetch(repoServing(CENTRAL, '9.9.9', content));
        const result = await ensureJar(s.options({ fetchImpl }));
        expect(result.source).to.equal('download');
      } finally {
        realFs.unlinkSync = realUnlink;
      }
    });

    it("uses another instance's finished jar after a rename collision", async () => {
      const s = sb('9.9.9');
      const target = path.join(s.cache, 'cql-ls-server-9.9.9.jar');
      const theirs = Buffer.concat([ZIP, Buffer.from('theirs')]);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const realFs = require('node:fs') as typeof fs;
      const realRename = realFs.renameSync;
      realFs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) === target) {
          fs.writeFileSync(target, theirs); // the other instance wins the race...
          throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); // ...and our rename fails
        }
        return realRename(from, to);
      }) as typeof fs.renameSync;
      try {
        const { fetchImpl } = fakeFetch(repoServing(CENTRAL, '9.9.9', content));
        const result = await ensureJar(s.options({ fetchImpl }));
        expect(result.jarPath).to.equal(target);
        expect(fs.readFileSync(target).equals(theirs)).to.equal(true);
        expect(fs.readdirSync(s.cache).filter((f) => f.includes('.part'))).to.deep.equal([]);
      } finally {
        realFs.renameSync = realRename;
      }
    });

    it('a rename failure with an invalid target is an error naming the file', async () => {
      const s = sb('9.9.9');
      const target = path.join(s.cache, 'cql-ls-server-9.9.9.jar');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const realFs = require('node:fs') as typeof fs;
      const realRename = realFs.renameSync;
      realFs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) === target) {
          throw Object.assign(new Error('locked'), { code: 'EPERM' });
        }
        return realRename(from, to);
      }) as typeof fs.renameSync;
      try {
        const { fetchImpl } = fakeFetch(repoServing(CENTRAL, '9.9.9', content));
        await ensureJar(s.options({ fetchImpl }));
        expect.fail('expected a throw');
      } catch (err) {
        expect((err as Error).message).to.include(target).and.to.include('EPERM');
      } finally {
        realFs.renameSync = realRename;
      }
      expect(fs.readdirSync(s.cache).filter((f) => f.includes('.part'))).to.deep.equal([]);
    });

    it('sweeps old .part-* files from the cache but keeps recent ones', async () => {
      const s = sb('9.9.9');
      fs.mkdirSync(s.cache, { recursive: true });
      const old = path.join(s.cache, 'cql-ls-server-1.0.0.jar.part-111');
      const recent = path.join(s.cache, 'cql-ls-server-1.0.0.jar.part-222');
      fs.writeFileSync(old, 'x');
      fs.writeFileSync(recent, 'x');
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
      const { fetchImpl } = fakeFetch(repoServing(CENTRAL, '9.9.9', content));
      await ensureJar(s.options({ fetchImpl }));
      expect(fs.existsSync(old)).to.equal(false);
      expect(fs.existsSync(recent)).to.equal(true);
    });

    it('never writes the password of a failing source to the log file', async () => {
      const logFile = path.join(tempDir(), 'mcp.log');
      dirs.push(path.dirname(logFile));
      configureLog({ level: 'debug', file: logFile });
      const s = sb('9.9.9', { CQL_LS_MAVEN_REPO: 'https://u:secret@repo.corp.test/maven/' });
      writeSettings(s.home, settingsXml('<servers><server><id>x</id><username>a</username><password>secret</password></server></servers>'));
      const { fetchImpl } = fakeFetch(() => reply(401, null));
      let error: Error | null = null;
      try {
        await ensureJar(s.options({ fetchImpl }));
      } catch (err) {
        error = err as Error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(error!.message).to.not.include('secret');
      expect(fs.readFileSync(logFile, 'utf8')).to.not.include('secret');
    });
  });
});
