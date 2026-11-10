import { expect } from 'chai';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureJar, getCqlLsCoords, getSearchUrl, JarInstallError } from '../../src/jvm/jarInstaller.js';
import type { JarInstallOptions } from '../../src/jvm/jarInstaller.js';
import { configureLog } from '../../src/log.js';
import { FakeMavenRepo } from '../helpers/fakeMavenRepo.js';
import { FakeProxy } from '../helpers/fakeProxy.js';
import { tlsFixture } from '../helpers/selfSignedServer.js';

const VERSION = '9.9.9';
const JAR_NAME = `cql-ls-server-${VERSION}.jar`;
const cli = path.resolve(__dirname, '..', 'helpers', 'resolveJarCli.js');
/** Nothing listens here: used so no test can ever reach the real Maven Central. */
const NOWHERE = 'http://127.0.0.1:9/';

const jarUrl = (repo: FakeMavenRepo): string => getSearchUrl(getCqlLsCoords(VERSION), repo.url);

function writeSettings(home: string, xml: string): void {
  fs.mkdirSync(path.join(home, '.m2'), { recursive: true });
  fs.writeFileSync(path.join(home, '.m2', 'settings.xml'), `<settings>${xml}</settings>`);
}

function mirrorXml(url: string, id = 'corp', mirrorOf = '*'): string {
  return `<mirrors><mirror><id>${id}</id><url>${url}</url><mirrorOf>${mirrorOf}</mirrorOf></mirror></mirrors>`;
}

function serverXml(id: string, user: string, pass: string): string {
  return `<servers><server><id>${id}</id><username>${user}</username><password>${pass}</password></server></servers>`;
}

interface CliResult {
  code: number | null;
  json: { ok: boolean; message?: string; jarPath?: string; source?: string } | null;
  stdout: string;
  stderr: string;
}

function runCli(env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    // A clean environment: no inherited proxies or CA settings can leak into the child.
    const child = spawn(process.execPath, [cli], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    const killer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.once('exit', (code) => {
      clearTimeout(killer);
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      let json: CliResult['json'] = null;
      try {
        json = line ? JSON.parse(line) : null;
      } catch {
        /* leave null */
      }
      resolve({ code, json, stdout, stderr });
    });
  });
}

const partFiles = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.includes('.part')) : []);

describe('net: jar resolution against local fake servers', function () {
  this.timeout(30_000);

  let root: string;
  let home: string;
  let cache: string;
  let logFile: string;
  const closers: Array<() => Promise<void>> = [];
  const track = async <T extends { close(): Promise<void> }>(p: Promise<T>): Promise<T> => {
    const v = await p;
    closers.push(() => v.close());
    return v;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cql-mcp-net-resolve-'));
    home = path.join(root, 'home');
    cache = path.join(root, 'cache');
    fs.mkdirSync(home, { recursive: true });
    logFile = path.join(root, 'mcp.log');
    configureLog({ level: 'debug', file: logFile });
  });

  afterEach(async () => {
    while (closers.length) await closers.pop()!();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const readLog = async (): Promise<string> => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  };

  const envFor = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    CQL_LS_VERSION: VERSION,
    CQL_MCP_JAR_DIR: cache,
    ...extra,
  });

  const options = (env: NodeJS.ProcessEnv, central: string = NOWHERE, extra: JarInstallOptions = {}): JarInstallOptions => ({
    homeDir: home,
    env,
    centralRepo: central,
    ...extra,
  });

  it('1. mirror before Central: the mirror is hit and Central never is', async () => {
    const mirror = await track(FakeMavenRepo.start());
    const central = await track(FakeMavenRepo.start());
    mirror.all({ kind: 'ok' });
    central.all({ kind: 'ok' });
    writeSettings(home, mirrorXml(mirror.url));
    const result = await ensureJar(options(envFor(), central.url));
    expect(result.source).to.equal('download');
    expect(mirror.jarRequests.length).to.be.greaterThan(0);
    expect(central.requests).to.have.length(0);
    expect(fs.readFileSync(result.jarPath).equals(mirror.jar)).to.equal(true);
  });

  it('2. fallback and aggregated error: repo 404, mirror stalls, Central ok → Central, failures logged in order', async () => {
    const repo = await track(FakeMavenRepo.start());
    const mirror = await track(FakeMavenRepo.start());
    const central = await track(FakeMavenRepo.start());
    repo.all({ kind: '404' });
    mirror.all({ kind: 'stall-after', bytes: 128 });
    central.all({ kind: 'ok' });
    writeSettings(home, mirrorXml(mirror.url));
    const result = await ensureJar(options(envFor({ CQL_LS_MAVEN_REPO: repo.url }), central.url, { downloadTimeoutMs: 400 }));
    expect(result.source).to.equal('download');
    expect(central.jarRequests.length).to.be.greaterThan(0);
    const log = await readLog();
    const iRepo = log.indexOf(`from ${jarUrl(repo)} failed: HTTP 404`);
    const iMirror = log.indexOf(`from ${jarUrl(mirror)} failed: stalled`);
    expect(iRepo, 'repo failure logged').to.be.greaterThan(-1);
    expect(iMirror, 'mirror failure logged').to.be.greaterThan(iRepo);
    expect(partFiles(cache)).to.deep.equal([]);
  });

  it('3. all fail: one JarInstallError names every URL with its reason; no credentials in message or log', async () => {
    const repo = await track(FakeMavenRepo.start());
    const mirror = await track(FakeMavenRepo.start());
    const central = await track(FakeMavenRepo.start());
    repo.all({ kind: '404' });
    mirror.all({ kind: '401-unless-basic-auth', user: 'alice', pass: 'hunter2-secret', then: { kind: '404' } });
    central.all({ kind: '404' });
    writeSettings(home, mirrorXml(mirror.url) + serverXml('corp', 'alice', 'hunter2-secret'));
    let error: JarInstallError | null = null;
    try {
      await ensureJar(options(envFor({ CQL_LS_MAVEN_REPO: repo.url }), central.url));
    } catch (err) {
      error = err as JarInstallError;
    }
    expect(error).to.be.instanceOf(JarInstallError);
    for (const r of [repo, mirror, central]) {
      expect(error!.message).to.include(jarUrl(r)).and.to.include('HTTP 404');
    }
    const log = await readLog();
    for (const text of [error!.message, log]) {
      expect(text).to.not.include('hunter2-secret');
      expect(text).to.not.include('alice');
      expect(text.toLowerCase()).to.not.include('authorization: basic');
      expect(text.toLowerCase()).to.not.match(/authorization[^\n]*basic [a-z0-9+/=]{6,}/);
    }
    expect(partFiles(cache)).to.deep.equal([]);
  });

  it('4. credentials go only to their own server', async () => {
    const mirror = await track(FakeMavenRepo.start());
    const central = await track(FakeMavenRepo.start());
    mirror.all({ kind: '401-unless-basic-auth', user: 'alice', pass: 'pw1', then: { kind: '404' } });
    central.all({ kind: 'ok' });
    writeSettings(home, mirrorXml(mirror.url) + serverXml('corp', 'alice', 'pw1'));
    const result = await ensureJar(options(envFor(), central.url));
    expect(result.source).to.equal('download');
    expect(mirror.requests.length).to.be.greaterThan(0);
    expect(mirror.requests.every((r) => r.hasAuthorization)).to.equal(true);
    expect(mirror.requests.every((r) => r.status !== 401)).to.equal(true);
    expect(central.requests.length).to.be.greaterThan(0);
    expect(central.requests.every((r) => !r.hasAuthorization)).to.equal(true);
  });

  it('5. placeholder credentials: set works; unset skips the value with a warning and ends in a 401, not a crash', async () => {
    const mirror = await track(FakeMavenRepo.start());
    mirror.all({ kind: '401-unless-basic-auth', user: 'alice', pass: 'from-env-pw' });
    writeSettings(
      home,
      mirrorXml(mirror.url) +
        '<servers><server><id>corp</id><username>alice</username><password>${env.TEST_REPO_PW}</password></server></servers>',
    );

    const ok = await ensureJar(options(envFor({ TEST_REPO_PW: 'from-env-pw' })));
    expect(ok.source).to.equal('download');

    fs.rmSync(cache, { recursive: true, force: true });
    let error: Error | null = null;
    try {
      await ensureJar(options(envFor())); // TEST_REPO_PW unset
    } catch (err) {
      error = err as Error;
    }
    expect(error).to.be.instanceOf(JarInstallError);
    expect(error!.message).to.include(jarUrl(mirror)).and.to.include('HTTP 401');
    expect(await readLog()).to.match(/Skipping <password> of Maven server 'corp'.*unset placeholder/);
  });

  describe('6. proxy routing', () => {
    it('HTTP_PROXY sends every request to the repo through the proxy', async () => {
      const repo = await track(FakeMavenRepo.start());
      const proxy = await track(FakeProxy.start());
      repo.all({ kind: 'ok' });
      const result = await ensureJar(options(envFor({ CQL_LS_MAVEN_REPO: repo.url, HTTP_PROXY: proxy.url() })));
      expect(result.source).to.equal('download');
      expect(proxy.requests.length).to.be.greaterThan(0);
      expect(proxy.requests.every((r) => r.target === repo.host)).to.equal(true);
      expect(repo.jarRequests.length).to.be.greaterThan(0);
    });

    it('NO_PROXY=127.0.0.1 bypasses the proxy', async () => {
      const repo = await track(FakeMavenRepo.start());
      const proxy = await track(FakeProxy.start());
      repo.all({ kind: 'ok' });
      await ensureJar(options(envFor({ CQL_LS_MAVEN_REPO: repo.url, HTTP_PROXY: proxy.url(), NO_PROXY: '127.0.0.1' })));
      expect(proxy.requests).to.have.length(0);
      expect(repo.jarRequests.length).to.be.greaterThan(0);
    });

    it('a dead proxy fails fast with an error that names the proxy', async () => {
      const repo = await track(FakeMavenRepo.start());
      repo.all({ kind: 'ok' });
      const started = Date.now();
      let error: Error | null = null;
      try {
        await ensureJar(options(envFor({ CQL_LS_MAVEN_REPO: repo.url, HTTP_PROXY: 'http://127.0.0.1:9' })));
      } catch (err) {
        error = err as Error;
      }
      expect(error).to.be.instanceOf(JarInstallError);
      expect(error!.message).to.include('via proxy http://127.0.0.1:9');
      expect(Date.now() - started).to.be.lessThan(5000);
      expect(repo.requests).to.have.length(0);
    });
  });

  describe('7. proxy Basic auth', () => {
    it('credentials in HTTP_PROXY authenticate against a proxy that requires them', async () => {
      const repo = await track(FakeMavenRepo.start());
      const proxy = await track(FakeProxy.start({ requireAuth: { user: 'u', pass: 'p' } }));
      repo.all({ kind: 'ok' });
      const result = await ensureJar(
        options(envFor({ CQL_LS_MAVEN_REPO: repo.url, HTTP_PROXY: proxy.url({ user: 'u', pass: 'p' }) })),
      );
      expect(result.source).to.equal('download');
      expect(proxy.requests.length).to.be.greaterThan(0);
      expect(proxy.requests.every((r) => r.hasProxyAuthorization && r.status !== 407)).to.equal(true);
    });

    it('without credentials the download fails, and the error does not include them', async () => {
      const repo = await track(FakeMavenRepo.start());
      const proxy = await track(FakeProxy.start({ requireAuth: { user: 'u', pass: 'p' } }));
      repo.all({ kind: 'ok' });
      let error: Error | null = null;
      try {
        await ensureJar(options(envFor({ CQL_LS_MAVEN_REPO: repo.url, HTTP_PROXY: proxy.url() })));
      } catch (err) {
        error = err as Error;
      }
      expect(error).to.be.instanceOf(JarInstallError);
      expect(error!.message).to.not.include('u:p');
      expect(proxy.requests.some((r) => r.status === 407)).to.equal(true);
      expect(repo.requests).to.have.length(0);
    });

    it('a wrong proxy password fails, and neither the message nor the log contains it', async () => {
      const repo = await track(FakeMavenRepo.start());
      const proxy = await track(FakeProxy.start({ requireAuth: { user: 'u', pass: 'right' } }));
      repo.all({ kind: 'ok' });
      let error: Error | null = null;
      try {
        await ensureJar(options(envFor({ CQL_LS_MAVEN_REPO: repo.url, HTTP_PROXY: proxy.url({ user: 'u', pass: 'wrong-proxy-pw' }) })));
      } catch (err) {
        error = err as Error;
      }
      expect(error).to.be.instanceOf(JarInstallError);
      expect(error!.message).to.not.include('wrong-proxy-pw');
      expect(await readLog()).to.not.include('wrong-proxy-pw');
    });
  });

  describe('8. corporate TLS (separate process: NODE_EXTRA_CA_CERTS is read at startup)', () => {
    it('fails with a TLS error without the CA, and succeeds with NODE_EXTRA_CA_CERTS', async () => {
      const tls = tlsFixture();
      const repo = await track(FakeMavenRepo.start({ tls }));
      repo.all({ kind: 'ok' });
      const env = {
        CQL_LS_VERSION: VERSION,
        CQL_MCP_JAR_DIR: cache,
        CQL_LS_MAVEN_REPO: repo.url,
        CQL_TEST_HOME: home,
        CQL_TEST_CENTRAL: NOWHERE,
      };

      const without = await runCli(env);
      expect(without.json?.ok).to.equal(false);
      expect(without.json?.message).to.match(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT|certificate/i);
      expect(fs.existsSync(path.join(cache, JAR_NAME))).to.equal(false);

      const withCa = await runCli({ ...env, NODE_EXTRA_CA_CERTS: tls.caPemPath });
      expect(withCa.json?.ok, withCa.json?.message).to.equal(true);
      expect(fs.existsSync(path.join(cache, JAR_NAME))).to.equal(true);
    });
  });

  it('9. stall timeout: stall-after(512) with a 500 ms timeout fails in about a second, and the process exits normally', async () => {
    const repo = await track(FakeMavenRepo.start());
    repo.all({ kind: 'stall-after', bytes: 512 });
    const started = Date.now();
    const res = await runCli({
      CQL_LS_VERSION: VERSION,
      CQL_MCP_JAR_DIR: cache,
      CQL_LS_MAVEN_REPO: repo.url,
      CQL_LS_DOWNLOAD_TIMEOUT_MS: '500',
      CQL_TEST_HOME: home,
      CQL_TEST_CENTRAL: NOWHERE,
    });
    const elapsed = Date.now() - started;
    expect(res.json?.ok).to.equal(false);
    expect(res.json?.message).to.include('stalled');
    expect(res.code, 'a clean exit (code 1 from the CLI) proves no timer or socket kept the process alive').to.equal(1);
    expect(elapsed, 'wall time incl. node startup').to.be.lessThan(8000);
    expect(partFiles(cache)).to.deep.equal([]);
  });

  describe('10. integrity', () => {
    it('wrong-sha1 fails that source and leaves no .part-* file', async () => {
      const repo = await track(FakeMavenRepo.start());
      repo.all({ kind: 'wrong-sha1' });
      let error: Error | null = null;
      try {
        await ensureJar(options(envFor({ CQL_LS_MAVEN_REPO: repo.url })));
      } catch (err) {
        error = err as Error;
      }
      expect(error!.message).to.include('SHA-1 mismatch');
      expect(partFiles(cache)).to.deep.equal([]);
      expect(fs.existsSync(path.join(cache, JAR_NAME))).to.equal(false);
    });

    it('short-body fails that source and leaves no .part-* file', async () => {
      const repo = await track(FakeMavenRepo.start());
      repo.all({ kind: 'short-body' });
      let error: Error | null = null;
      try {
        await ensureJar(options(envFor({ CQL_LS_MAVEN_REPO: repo.url })));
      } catch (err) {
        error = err as Error;
      }
      expect(error).to.be.instanceOf(JarInstallError);
      expect(partFiles(cache)).to.deep.equal([]);
      expect(fs.existsSync(path.join(cache, JAR_NAME))).to.equal(false);
    });

    it('sha1-404 warns and accepts the jar', async () => {
      const repo = await track(FakeMavenRepo.start());
      repo.all({ kind: 'sha1-404' });
      const result = await ensureJar(options(envFor({ CQL_LS_MAVEN_REPO: repo.url })));
      expect(result.source).to.equal('download');
      expect(await readLog()).to.include('No .sha1 published');
    });

    it('sha1-500 fails that source', async () => {
      const repo = await track(FakeMavenRepo.start());
      repo.all({ kind: 'sha1-500' });
      let error: Error | null = null;
      try {
        await ensureJar(options(envFor({ CQL_LS_MAVEN_REPO: repo.url })));
      } catch (err) {
        error = err as Error;
      }
      expect(error!.message).to.include('HTTP 500');
      expect(partFiles(cache)).to.deep.equal([]);
    });

    it('accepts a .sha1 with a filename suffix', async () => {
      const repo = await track(FakeMavenRepo.start());
      repo.all({ kind: 'sha1-with-filename-suffix' });
      expect((await ensureJar(options(envFor({ CQL_LS_MAVEN_REPO: repo.url })))).source).to.equal('download');
    });
  });

  it('11. HEAD rejected (405) still downloads', async () => {
    const repo = await track(FakeMavenRepo.start());
    repo.all({ kind: 'head-405' });
    const result = await ensureJar(options(envFor({ CQL_LS_MAVEN_REPO: repo.url })));
    expect(result.source).to.equal('download');
    expect(repo.requests.some((r) => r.method === 'HEAD' && r.status === 405)).to.equal(true);
  });

  it('12. concurrent first run: two processes against one empty cache both succeed, leaving one jar and no .part files', async () => {
    const repo = await track(FakeMavenRepo.start());
    repo.all({ kind: 'ok' });
    const env = {
      CQL_LS_VERSION: VERSION,
      CQL_MCP_JAR_DIR: cache,
      CQL_LS_MAVEN_REPO: repo.url,
      CQL_TEST_HOME: home,
      CQL_TEST_CENTRAL: NOWHERE,
    };
    const [a, b] = await Promise.all([runCli(env), runCli(env)]);
    expect(a.json?.ok, a.json?.message).to.equal(true);
    expect(b.json?.ok, b.json?.message).to.equal(true);
    expect(fs.readdirSync(cache)).to.deep.equal([JAR_NAME]);
    expect(fs.readFileSync(path.join(cache, JAR_NAME)).equals(repo.jar)).to.equal(true);
  });

  it('never leaks configured credentials: URL userinfo, settings server password and Authorization stay out of the error and the log', async () => {
    const repo = await track(FakeMavenRepo.start());
    const mirror = await track(FakeMavenRepo.start());
    repo.all({ kind: '401-unless-basic-auth', user: 'u', pass: 'right-pw' }); // the URL's password is wrong → 401
    mirror.all({ kind: '401-unless-basic-auth', user: 'm', pass: 'right-pw' }); // the settings password is wrong → 401
    const repoWithUserinfo = repo.url.replace('http://', 'http://u:secret@');
    writeSettings(home, mirrorXml(mirror.url) + serverXml('corp', 'm', 'secret'));
    let error: JarInstallError | null = null;
    try {
      await ensureJar(options(envFor({ CQL_LS_MAVEN_REPO: repoWithUserinfo })));
    } catch (err) {
      error = err as JarInstallError;
    }
    expect(error).to.be.instanceOf(JarInstallError);
    expect(error!.message).to.include('HTTP 401');
    expect(error!.message).to.not.include('secret');
    expect(JSON.stringify(error!.detail)).to.not.include('secret');
    const log = await readLog();
    expect(log).to.not.include('secret');
    expect(log.toLowerCase()).to.not.match(/authorization/);
  });
});
