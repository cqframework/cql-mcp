import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_CQL_LS_VERSION,
  ensureJar,
  getCqlLsCoords,
  getLocalName,
  getSearchUrl,
  JarInstallError,
} from '../../../src/jvm/jarInstaller.js';

const ORIGINAL_ENV = { ...process.env };

interface FakeBody {
  getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> };
}

interface FakeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  body: FakeBody | null;
}

function responseWith(status: number, body: Uint8Array | null, failOnRead = false): FakeResponse {
  let reads = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    headers: {
      get: (name) => (name.toLowerCase() === 'content-length' && body ? String(body.byteLength) : null),
    },
    body: body
      ? {
          getReader: () => ({
            read: async () => {
              if (failOnRead && reads === 1) {
                throw new Error('simulated stream failure');
              }
              reads += 1;
              if (reads > 1 || body === null) {
                return { done: true };
              }
              return { done: false, value: body };
            },
          }),
        }
      : null,
  };
}

function makeFetch(responses: Array<FakeResponse>) {
  return async (): Promise<FakeResponse> => responses.shift()!;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cql-jar-'));
}

describe('jvm/jarInstaller', () => {
  const envKeys = ['CQL_LS_JAR_PATH', 'CQL_LS_VERSION', 'CQL_LS_MAVEN_REPO', 'CQL_MCP_JAR_DIR', 'CQL_DEBUG_MCP_JAR_DIR'];

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    for (const key of envKeys) {
      delete process.env[key];
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

  describe('CQL_LS_JAR_PATH override', () => {
    it('returns the env jar unchanged when it exists', async () => {
      const dir = tempDir();
      try {
        const jar = path.join(dir, 'local.jar');
        fs.writeFileSync(jar, 'fake');
        process.env.CQL_LS_JAR_PATH = jar;
        const result = await ensureJar();
        expect(result).to.deep.equal({ jarPath: jar, downloaded: false, source: 'env' });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('throws a structured JarInstallError when the env jar is missing', async () => {
      process.env.CQL_LS_JAR_PATH = '/does/not/exist/cql-ls-server.jar';
      try {
        await ensureJar();
        expect.fail('expected ensureJar to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(JarInstallError);
        expect((err as JarInstallError).message).to.include('CQL_LS_JAR_PATH');
      }
    });
  });

  it('defaults to LS 5.0.0', () => {
    expect(DEFAULT_CQL_LS_VERSION).to.equal('5.0.0');
  });

  describe('legacy cache and env fallbacks', () => {
    const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

    // os.homedir() reads the real environment, so inject the legacy cache dir instead.
    function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
      const home = tempDir();
      return fn(home).finally(() => fs.rmSync(home, { recursive: true, force: true }));
    }

    it('accepts the legacy CQL_DEBUG_MCP_JAR_DIR override', async () => {
      const dir = tempDir();
      try {
        process.env.CQL_LS_VERSION = '9.9.9';
        process.env.CQL_DEBUG_MCP_JAR_DIR = dir;
        const jarPath = path.join(dir, 'cql-ls-server-9.9.9.jar');
        fs.writeFileSync(jarPath, ZIP);
        const result = await ensureJar();
        expect(result.jarPath).to.equal(jarPath);
        expect(result.source).to.equal('cache');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('uses a valid jar in the legacy cache in place when no override is set', async () => {
      await withHome(async (home) => {
        process.env.CQL_LS_VERSION = '9.9.9';
        const legacyDir = path.join(home, '.cql-debug-mcp', 'jars');
        fs.mkdirSync(legacyDir, { recursive: true });
        const legacyJar = path.join(legacyDir, 'cql-ls-server-9.9.9.jar');
        fs.writeFileSync(legacyJar, ZIP);
        const result = await ensureJar({ legacyCacheDir: legacyDir });
        expect(result).to.deep.equal({ jarPath: legacyJar, downloaded: false, source: 'cache' });
        expect(fs.existsSync(path.join(home, '.cql-mcp'))).to.equal(false);
      });
    });

    it('does not check the legacy cache when CQL_MCP_JAR_DIR is set', async () => {
      await withHome(async (home) => {
        process.env.CQL_LS_VERSION = '9.9.9';
        const legacyDir = path.join(home, '.cql-debug-mcp', 'jars');
        fs.mkdirSync(legacyDir, { recursive: true });
        fs.writeFileSync(path.join(legacyDir, 'cql-ls-server-9.9.9.jar'), ZIP);
        const newDir = path.join(home, 'custom');
        process.env.CQL_MCP_JAR_DIR = newDir;
        try {
          await ensureJar({
            legacyCacheDir: legacyDir,
            fetchImpl: (async () => ({ ok: false, status: 404, statusText: 'Not Found' })) as unknown as typeof fetch,
          });
          expect.fail('expected ensureJar to attempt a download and fail');
        } catch (err) {
          expect(err).to.be.instanceOf(JarInstallError);
        }
      });
    });
  });

  describe('cached jar', () => {
    it('reuses a valid cached jar (ZIP magic header) without downloading', async () => {
      const dir = tempDir();
      try {
        process.env.CQL_LS_JAR_PATH = '';
        process.env.CQL_LS_VERSION = '9.9.9';
        process.env.CQL_MCP_JAR_DIR = dir;
        const jarPath = path.join(dir, 'cql-ls-server-9.9.9.jar');
        // PK\x03\x04 ZIP local-file-header magic followed by zero bytes.
        fs.writeFileSync(jarPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
        const result = await ensureJar();
        expect(result.source).to.equal('cache');
        expect(result.downloaded).to.equal(false);
        expect(result.jarPath).to.equal(jarPath);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('re-downloads when the cached jar is empty', async () => {
      const dir = tempDir();
      try {
        process.env.CQL_LS_JAR_PATH = '';
        process.env.CQL_LS_VERSION = '1.2.3';
        process.env.CQL_MCP_JAR_DIR = dir;
        const jarPath = path.join(dir, 'cql-ls-server-1.2.3.jar');
        fs.writeFileSync(jarPath, ''); // 0-byte
        const content = new TextEncoder().encode('jar-bytes');
        const fetchImpl = makeFetch([
          responseWith(200, content),
          responseWith(200, content),
        ]);
        const result = await ensureJar({ fetchImpl: fetchImpl as unknown as typeof fetch });
        expect(result.source).to.equal('download');
        expect(result.downloaded).to.equal(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('re-downloads when the cached jar has non-JAR content', async () => {
      const dir = tempDir();
      try {
        process.env.CQL_LS_JAR_PATH = '';
        process.env.CQL_LS_VERSION = '1.2.4';
        process.env.CQL_MCP_JAR_DIR = dir;
        const jarPath = path.join(dir, 'cql-ls-server-1.2.4.jar');
        fs.writeFileSync(jarPath, 'this is not a jar file at all');
        const content = new TextEncoder().encode('jar-bytes');
        const fetchImpl = makeFetch([
          responseWith(200, content),
          responseWith(200, content),
        ]);
        const result = await ensureJar({ fetchImpl: fetchImpl as unknown as typeof fetch });
        expect(result.source).to.equal('download');
        expect(result.downloaded).to.equal(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('download', () => {
    it('downloads, verifies, and renames from .part to the final jar', async () => {
      const dir = tempDir();
      try {
        process.env.CQL_LS_JAR_PATH = '';
        process.env.CQL_LS_VERSION = '1.0.0';
        process.env.CQL_MCP_JAR_DIR = dir;
        const content = new TextEncoder().encode('jar-bytes');
        const fetchImpl = makeFetch([
          responseWith(200, content),
          responseWith(200, content),
        ]);
        let received = 0;
        const result = await ensureJar({ fetchImpl: fetchImpl as unknown as typeof fetch, onProgress: (d) => { received = d.received; } });
        const jarPath = path.join(dir, 'cql-ls-server-1.0.0.jar');
        expect(result).to.deep.equal({ jarPath, downloaded: true, source: 'download' });
        expect(fs.readFileSync(jarPath, 'utf8')).to.equal('jar-bytes');
        expect(fs.existsSync(`${jarPath}.part`)).to.equal(false);
        expect(received).to.equal('jar-bytes'.length);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('fails with a structured error on HTTP error', async () => {
      const dir = tempDir();
      try {
        process.env.CQL_LS_JAR_PATH = '';
        process.env.CQL_MCP_JAR_DIR = dir;
        // HEAD consumes the first response; GET consumes the second.
        const fetchImpl = makeFetch([responseWith(404, null), responseWith(404, null)]);
        try {
          await ensureJar({ fetchImpl: fetchImpl as unknown as typeof fetch });
          expect.fail('expected ensureJar to throw');
        } catch (err) {
          expect(err).to.be.instanceOf(JarInstallError);
          const detail = (err as JarInstallError).detail;
          expect(detail.url).to.include('org/opencds/cqf/cql/ls');
          expect((err as JarInstallError).message).to.include('404');
          // SNAPSHOT hint included on 404.
          expect((err as JarInstallError).message).to.include('SNAPSHOT');
          expect((err as JarInstallError).message).to.include('CQL_LS_JAR_PATH');
          expect((err as JarInstallError).message).to.include('CQL_LS_VERSION');
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('cleans up the partial file when the stream fails mid-download', async () => {
      const dir = tempDir();
      try {
        process.env.CQL_LS_JAR_PATH = '';
        process.env.CQL_LS_VERSION = '1.0.0';
        process.env.CQL_MCP_JAR_DIR = dir;
        const content = new TextEncoder().encode('some-jar-content');
        // First response serves HEAD; the stream failure is on the GET response.
        const fetchImpl = makeFetch([responseWith(200, content), responseWith(200, content, true)]);
        try {
          await ensureJar({ fetchImpl: fetchImpl as unknown as typeof fetch });
          expect.fail('expected ensureJar to throw');
        } catch (err) {
          expect(err).to.be.instanceOf(JarInstallError);
        }
        expect(fs.existsSync(path.join(dir, 'cql-ls-server-1.0.0.jar.part'))).to.equal(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});