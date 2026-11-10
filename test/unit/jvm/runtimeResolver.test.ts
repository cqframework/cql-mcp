import { expect } from 'chai';
import { RuntimeResolver } from '../../../src/jvm/runtimeResolver.js';
import { JarInstallError } from '../../../src/jvm/jarInstaller.js';
import type { JarInstallOptions, JarResolution } from '../../../src/jvm/jarInstaller.js';
import { CqlLsProcess } from '../../../src/jvm/cqlLsProcess.js';

const JAVA = { javaPath: '/opt/java', version: 21 };
const JAR: JarResolution = { jarPath: '/jars/cql-ls-server-5.0.0.jar', downloaded: false, source: 'cache' };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('jvm/runtimeResolver', () => {
  it('starts idle', () => {
    const r = new RuntimeResolver({ findJava: () => JAVA, resolveJar: async () => JAR });
    expect(r.status()).to.deep.equal({ state: 'idle' });
  });

  it('shares one resolution between concurrent callers', async () => {
    let javaCalls = 0;
    let jarCalls = 0;
    const r = new RuntimeResolver({
      findJava: () => {
        javaCalls += 1;
        return JAVA;
      },
      resolveJar: async () => {
        jarCalls += 1;
        return JAR;
      },
    });
    const [a, b, c] = await Promise.all([r.resolve(), r.resolve(), r.resolve()]);
    expect(a).to.equal(b);
    expect(b).to.equal(c);
    expect(javaCalls).to.equal(1);
    expect(jarCalls).to.equal(1);
    await r.resolve();
    expect(jarCalls).to.equal(1); // memoized after success
  });

  it('reports idle → resolving (java, then jar) → ready', async () => {
    const jarGate = deferred<JarResolution>();
    const seen: Array<{ state: string; phase?: string }> = [];
    const r = new RuntimeResolver({
      findJava: () => {
        seen.push({ state: r.status().state, phase: r.status().phase });
        return JAVA;
      },
      resolveJar: () => {
        seen.push({ state: r.status().state, phase: r.status().phase });
        return jarGate.promise;
      },
    });
    const p = r.resolve();
    expect(r.status()).to.deep.equal({ state: 'resolving', phase: 'java' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.status()).to.deep.equal({ state: 'resolving', phase: 'jar' });
    jarGate.resolve(JAR);
    const resolved = await p;
    expect(seen).to.deep.equal([
      { state: 'resolving', phase: 'java' },
      { state: 'resolving', phase: 'jar' },
    ]);
    expect(resolved).to.deep.equal({
      javaPath: '/opt/java',
      javaVersion: 21,
      jarPath: JAR.jarPath,
      jarSource: 'cache',
      lsVersion: '5.0.0',
    });
    expect(r.status()).to.deep.equal({
      state: 'ready',
      jarSource: 'cache',
      jarPath: JAR.jarPath,
      lsVersion: '5.0.0',
      javaVersion: 21,
    });
  });

  it('does not cache a failure: the next resolve() retries and can succeed', async () => {
    let attempt = 0;
    const r = new RuntimeResolver({
      findJava: () => JAVA,
      resolveJar: async () => {
        attempt += 1;
        if (attempt === 1) throw new JarInstallError('HTTP 503');
        return JAR;
      },
    });
    let error: Error | null = null;
    try {
      await r.resolve();
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).to.include('Failed to obtain the cql-language-server jar: HTTP 503');
    expect(error?.message).to.include('CQL_LS_JAR_PATH');
    expect(r.status().state).to.equal('failed');
    expect(r.status().error).to.include('HTTP 503');

    const resolved = await r.resolve();
    expect(resolved.jarPath).to.equal(JAR.jarPath);
    expect(r.status().state).to.equal('ready');
    expect(r.status().error).to.equal(undefined);
    expect(attempt).to.equal(2);
  });

  it('fails with the "No Java >= 17" message when Java is missing, without touching the jar', async () => {
    let jarCalls = 0;
    const r = new RuntimeResolver({
      findJava: () => null,
      resolveJar: async () => {
        jarCalls += 1;
        return JAR;
      },
    });
    let error: Error | null = null;
    try {
      await r.resolve();
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).to.match(/^No Java >= 17 found\. Set JAVA_HOME or add java to PATH\./);
    expect(jarCalls).to.equal(0);
    expect(r.status()).to.include({ state: 'failed' });
  });

  it('treats a throwing Java probe as "not found"', async () => {
    const r = new RuntimeResolver({
      findJava: () => {
        throw new Error('spawn blew up');
      },
      resolveJar: async () => JAR,
    });
    let error: Error | null = null;
    try {
      await r.resolve();
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).to.include('No Java >= 17 found');
  });

  it('exposes download progress in status(), with userinfo stripped from the URL', async () => {
    const gate = deferred<JarResolution>();
    let opts: JarInstallOptions | undefined;
    const r = new RuntimeResolver({
      findJava: () => JAVA,
      resolveJar: (o) => {
        opts = o;
        return gate.promise;
      },
    });
    const p = r.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    opts!.onProgress!({ url: 'https://user:s3cret@repo.example.com/x/cql-ls-server-5.0.0.jar', bytes: 100, totalBytes: 1000 });
    const status = r.status();
    expect(status.download).to.deep.equal({
      url: 'https://repo.example.com/x/cql-ls-server-5.0.0.jar',
      bytes: 100,
      totalBytes: 1000,
    });
    expect(JSON.stringify(status)).to.not.include('s3cret');
    gate.resolve({ ...JAR, source: 'download', downloaded: true });
    await p;
    expect(r.status().download).to.equal(undefined);
    expect(r.status().jarSource).to.equal('download');
  });

  it('start() returns immediately and never causes an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const r = new RuntimeResolver({
        findJava: () => null,
        resolveJar: async () => JAR,
      });
      r.start();
      expect(r.status().state).to.equal('resolving');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(r.status().state).to.equal('failed');
      r.start(); // retries after failure, still no unhandled rejection
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).to.have.length(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('lsVersion is null when the jar name does not carry a version', async () => {
    const r = new RuntimeResolver({
      findJava: () => JAVA,
      resolveJar: async () => ({ jarPath: '/x/custom.jar', downloaded: false, source: 'env' }),
    });
    expect((await r.resolve()).lsVersion).to.equal(null);
  });

  describe('lazy startup through CqlLsProcess (ADR-0001 §2.2)', () => {
    it('ensureReady() rejects with the "No Java >= 17" message and spawns nothing', async () => {
      let spawned = 0;
      const proc = new CqlLsProcess({
        runtime: new RuntimeResolver({ findJava: () => null, resolveJar: async () => JAR }),
        workspacePath: '/work',
        spawnImpl: (() => {
          spawned += 1;
          throw new Error('should not spawn');
        }) as never,
      });
      let error: Error | null = null;
      try {
        await proc.ensureReady();
      } catch (err) {
        error = err as Error;
      }
      expect(error?.message).to.include('No Java >= 17 found');
      expect(spawned).to.equal(0);
      expect(proc.currentState).to.equal('idle');
    });

    it('executeCommand() surfaces the same error', async () => {
      const proc = new CqlLsProcess({
        runtime: new RuntimeResolver({ findJava: () => null, resolveJar: async () => JAR }),
        workspacePath: '/work',
      });
      let error: Error | null = null;
      try {
        await proc.executeCommand('x', []);
      } catch (err) {
        error = err as Error;
      }
      expect(error?.message).to.include('No Java >= 17 found');
    });
  });
});
