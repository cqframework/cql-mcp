import { expect } from 'chai';
import { getStatusTool } from '../../../src/tools/statusTool.js';
import type { McpContext } from '../../../src/tools/defs.js';
import { RuntimeResolver } from '../../../src/jvm/runtimeResolver.js';
import type { JarResolution } from '../../../src/jvm/jarInstaller.js';
import type { CqlLsProcess } from '../../../src/jvm/cqlLsProcess.js';
import type { DapSession } from '../../../src/dap/dapSession.js';

const JAR: JarResolution = { jarPath: '/jars/cql-ls-server-5.0.0.jar', downloaded: false, source: 'vscode-extension' as never };

function ctx(runtime: RuntimeResolver, proc: Partial<CqlLsProcess> = {}): McpContext {
  return {
    process: {
      currentState: 'idle',
      ensureReady: async () => undefined,
      executeCommand: async () => ({ languageServer: '5.0.0' }),
      ...proc,
    } as unknown as CqlLsProcess,
    debugSession: { isActive: false } as unknown as DapSession,
    runtime,
    workspaceRoot: '/workspace',
  };
}

describe('tools/statusTool', () => {
  it('starts resolution on the first call and does not block while the jar is resolving', async () => {
    let release!: (r: JarResolution) => void;
    const runtime = new RuntimeResolver({
      findJava: () => ({ javaPath: '/java', version: 17 }),
      resolveJar: (o) => {
        o?.onProgress?.({ url: 'https://user:pw@repo.example/cql-ls-server-5.0.0.jar', bytes: 5, totalBytes: 50 });
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    let ensureCalls = 0;
    const c = ctx(runtime, {
      ensureReady: async () => {
        ensureCalls += 1;
      },
    });

    const first = (await getStatusTool.handler(c, {})) as Record<string, any>;
    expect(first.runtime.state).to.equal('resolving');
    expect(first.runtime.phase).to.equal('java');
    expect(first.ready).to.equal(false);
    expect(first.jarSource).to.equal(null);
    expect(first.languageServerVersion).to.equal(null);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = (await getStatusTool.handler(c, {})) as Record<string, any>;
    expect(second.runtime.state).to.equal('resolving');
    expect(second.runtime.phase).to.equal('jar');
    expect(second.runtime.download).to.deep.equal({
      url: 'https://repo.example/cql-ls-server-5.0.0.jar',
      bytes: 5,
      totalBytes: 50,
    });
    expect(JSON.stringify(second)).to.not.include('pw@');
    expect(ensureCalls).to.equal(0); // never touches the LS while resolving
    release(JAR);
  });

  it('reports jarPath, jarSource, javaVersion and the LS version once ready', async () => {
    const runtime = new RuntimeResolver({
      findJava: () => ({ javaPath: '/java', version: 21 }),
      resolveJar: async () => JAR,
    });
    await runtime.resolve();
    const out = (await getStatusTool.handler(ctx(runtime, { currentState: 'ready' }), {})) as Record<string, any>;
    expect(out).to.include({
      ready: true,
      state: 'ready',
      jarPath: JAR.jarPath,
      jarSource: 'vscode-extension',
      javaVersion: 21,
      languageServerVersion: '5.0.0',
      workspaceRoot: '/workspace',
      activeDebugSession: false,
    });
    expect(out.runtime).to.deep.equal({ state: 'ready', phase: null, download: null, error: null });
  });

  it('reports a resolution failure without throwing, and retries on the next call', async () => {
    const runtime = new RuntimeResolver({ findJava: () => null, resolveJar: async () => JAR });
    await runtime.resolve().catch(() => undefined);
    expect(runtime.status().error).to.include('No Java >= 17 found');
    // The call itself retries (start()), so it reports the new attempt rather than throwing.
    const out = (await getStatusTool.handler(ctx(runtime), {})) as Record<string, any>;
    expect(out.runtime.state).to.equal('resolving');
    expect(out.ready).to.equal(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtime.status()).to.include({ state: 'failed' });
    expect(runtime.status().error).to.include('No Java >= 17 found');
  });
});
