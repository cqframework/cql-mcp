import { expect } from 'chai';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { MessageConnection } from 'vscode-jsonrpc/node';
import { CqlLsProcess, LanguageServerCrashedError } from '../../../src/jvm/cqlLsProcess.js';
import { createServerConnection } from '../../helpers/channel.js';

class FakeChild extends EventEmitter {
  pid = 1000 + Math.floor(Math.random() * 9000);
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(signal?: string): boolean {
    if (this.exitCode !== null || this.signalCode !== null) {
      return false;
    }
    setImmediate(() => {
      this.exitCode = signal ? null : 0;
      this.signalCode = signal ?? null;
      this.emit('exit', this.exitCode, this.signalCode);
    });
    return true;
  }
}

interface SpawnCall {
  javaPath: string;
  args: string[];
}

interface SpawnHarness {
  spawnImpl: typeof spawn;
  children: FakeChild[];
  servers: MessageConnection[];
  spawnCalls: SpawnCall[];
  heldExecuteReplies: Array<(value: unknown) => void>;
}

function makeHarness(opts?: {
  hangInitialize?: boolean;
  holdExecuteReplies?: boolean;
  /** The server never answers the LSP `shutdown` request (a wedged JVM). */
  hangShutdown?: boolean;
}): SpawnHarness {
  const hangInitialize = opts?.hangInitialize ?? false;
  const hangShutdown = opts?.hangShutdown ?? false;
  const holdExecuteReplies = opts?.holdExecuteReplies ?? false;
  const children: FakeChild[] = [];
  const servers: MessageConnection[] = [];
  const spawnCalls: SpawnCall[] = [];
  const heldExecuteReplies: Array<(value: unknown) => void> = [];

  const spawner = (javaPath: string, args: string[]): ChildProcess => {
    const call: SpawnCall = { javaPath, args };
    spawnCalls.push(call);
    const child = new FakeChild();
    children.push(child);

    const server = createServerConnection({ read: child.stdin, write: child.stdout });
    servers.push(server);
    // A hanging handler simulates a server that never answers initialize.
    server.onRequest('initialize', () => (hangInitialize ? new Promise(() => undefined) : { capabilities: {} }));
    server.onNotification('initialized', () => undefined);
    server.onRequest('shutdown', () => (hangShutdown ? new Promise(() => undefined) : null));
    server.onNotification('exit', () => void child.kill());
    server.onRequest('workspace/executeCommand', (params: { command: string; arguments?: unknown[] }) => {
      const reply = { echo: params.command, nargs: params.arguments?.length ?? 0 };
      if (!holdExecuteReplies) {
        return reply;
      }
      return new Promise((resolve) => heldExecuteReplies.push(resolve));
    });

    return child as unknown as ChildProcess;
  };

  return {
    spawnImpl: spawner as unknown as typeof spawn,
    children,
    servers,
    spawnCalls,
    heldExecuteReplies,
  };
}

function afterEachCleanup(proc: CqlLsProcess | null): void {
  if (proc) {
    void proc.stop();
  }
}

describe('jvm/cqlLsProcess', () => {
  it('spawns with expected args, initializes, and round-trips executeCommand', async () => {
    const harness = makeHarness();
    const proc = new CqlLsProcess({
      javaPath: '/opt/java',
      jarPath: '/jars/cql-ls-server.jar',
      workspacePath: '/work',
      spawnImpl: harness.spawnImpl,
      initializeTimeoutMs: 2000,
    });

    try {
      await proc.ensureReady();
      expect(proc.currentState).to.equal('ready');
      expect(harness.spawnCalls).to.have.length(1);
      const call = harness.spawnCalls[0];
      expect(call.javaPath).to.equal('/opt/java');
      expect(call.args).to.include('-jar');
      expect(call.args).to.include('/jars/cql-ls-server.jar');
      expect(call.args).to.include('-workspace');
      expect(call.args).to.include('/work');

      const result = await proc.executeCommand('org.opencds.cqf.cql.ls.executeCql', [1, 2]);
      expect(result).to.deep.equal({ echo: 'org.opencds.cqf.cql.ls.executeCql', nargs: 2 });
    } finally {
      await proc.stop();
    }
  });

  it('recovers from a crash by respawning transparently on the next call', async () => {
    const harness = makeHarness();
    const proc = new CqlLsProcess({
      javaPath: '/opt/java',
      jarPath: '/jars/cql-ls-server.jar',
      workspacePath: '/work',
      spawnImpl: harness.spawnImpl,
      initializeTimeoutMs: 2000,
    });

    try {
      await proc.ensureReady();
      const first = await proc.executeCommand('cmd', ['a']);
      expect((first as { echo: string }).echo).to.equal('cmd');

      harness.children[0].kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 20));
      expect(proc.currentState).to.equal('crashed');
      expect(proc.crashInfo?.signal).to.equal('SIGKILL');

      const second = await proc.executeCommand('cmd', ['b']);
      expect((second as { echo: string }).echo).to.equal('cmd');
      expect(harness.spawnCalls).to.have.length(2);
      expect(proc.currentState).to.equal('ready');
    } finally {
      await proc.stop();
    }
  });

  it('rejects an in-flight command with a structured crash error when the JVM dies mid-call', async () => {
    const harness = makeHarness({ holdExecuteReplies: true });
    const proc = new CqlLsProcess({
      javaPath: '/opt/java',
      jarPath: '/jars/cql-ls-server.jar',
      workspacePath: '/work',
      spawnImpl: harness.spawnImpl,
      initializeTimeoutMs: 2000,
    });

    try {
      await proc.ensureReady();
      // Do not await: the server holds the reply until we release it.
      const inFlight = proc.executeCommand('cmd', ['x']);
      await new Promise((r) => setTimeout(r, 20));

      harness.children[0].kill('SIGKILL');
      harness.heldExecuteReplies.forEach((resolve) => resolve({}));

      let threw: unknown;
      try {
        await inFlight;
      } catch (err) {
        threw = err;
      }
      expect(threw).to.be.instanceOf(LanguageServerCrashedError);
    } finally {
      await proc.stop();
    }
  });

  it('fails cleanly and marks crashed when the server never answers initialize', async () => {
    const harness = makeHarness({ hangInitialize: true });
    const proc = new CqlLsProcess({
      javaPath: '/opt/java',
      jarPath: '/jars/cql-ls-server.jar',
      workspacePath: '/work',
      spawnImpl: harness.spawnImpl,
      initializeTimeoutMs: 50,
    });

    let rejected = false;
    try {
      await proc.ensureReady();
    } catch (err) {
      rejected = true;
      expect((err as Error).message).to.include('did not answer initialize');
    }
    expect(rejected).to.equal(true);
    expect(proc.currentState).to.equal('crashed');
    await proc.stop();
  });

  it('hard-stops at the respawn limit', async () => {
    const harness = makeHarness({ hangInitialize: true });
    const proc = new CqlLsProcess({
      javaPath: '/opt/java',
      jarPath: '/jars/cql-ls-server.jar',
      workspacePath: '/work',
      spawnImpl: harness.spawnImpl,
      initializeTimeoutMs: 20,
      respawnLimit: 1,
    });

    let caught: Error | undefined;
    try {
      await proc.ensureReady();
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).to.include('did not answer initialize');

    let limitError: Error | undefined;
    try {
      await proc.ensureReady();
    } catch (err) {
      limitError = err as Error;
    }
    expect(limitError?.message).to.include('respawn limit');
    expect(harness.spawnCalls).to.have.length(1);
    await proc.stop();
  });

  it('stop() does not wait forever when the server never answers shutdown', async () => {
    const harness = makeHarness({ hangShutdown: true });
    const proc = new CqlLsProcess({
      javaPath: '/opt/java',
      jarPath: '/jars/cql-ls-server.jar',
      workspacePath: '/work',
      spawnImpl: harness.spawnImpl,
      initializeTimeoutMs: 2000,
      shutdownTimeoutMs: 50,
    });

    await proc.ensureReady();
    const t0 = Date.now();
    await proc.stop();
    expect(Date.now() - t0).to.be.lessThan(2000);
    expect(proc.currentState).to.equal('stopped');
    const child = harness.children[0]!;
    expect(child.exitCode !== null || child.signalCode !== null).to.equal(true);
  });

  it('refuses new work after being stopped', async () => {
    const harness = makeHarness();
    const proc = new CqlLsProcess({
      javaPath: '/opt/java',
      jarPath: '/jars/cql-ls-server.jar',
      workspacePath: '/work',
      spawnImpl: harness.spawnImpl,
      initializeTimeoutMs: 2000,
    });

    await proc.ensureReady();
    await proc.stop();
    expect(proc.currentState).to.equal('stopped');

    let threw = false;
    try {
      await proc.executeCommand('cmd', []);
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
    await afterEachCleanup(proc);
  });

  it('detects a second crash after respawn (stopping flag is reset between lifecycles)', async () => {
    // Regression test for the stopping-flag bug: teardownUnexpected() sets
    // stopping=true. If spawnAndInitialize() does NOT reset it on respawn,
    // the post-respawn child.once('exit') handler will skip handleGone()
    // forever and any subsequent crash will not transition state to
    // 'crashed'.
    //
    // Scenario: first child hangs on initialize → timeout → teardown.
    // We then flip the harness so the second initialize succeeds and
    // executeCommand round-trips. Then we kill the second child externally.
    // With the fix, that kill is detected via the exit handler. Without
    // the fix, stopping stays true and the handler skips handleGone,
    // leaving state stuck at 'ready'.
    let hangInitialize = true;
    const harness = (() => {
      const children: FakeChild[] = [];
      const servers: MessageConnection[] = [];
      const spawnCalls: SpawnCall[] = [];
      const spawner = (javaPath: string, args: string[]): ChildProcess => {
        spawnCalls.push({ javaPath, args });
        const child = new FakeChild();
        children.push(child);
        const server = createServerConnection({ read: child.stdin, write: child.stdout });
        servers.push(server);
        server.onRequest('initialize', () =>
          hangInitialize ? new Promise(() => undefined) : { capabilities: {} },
        );
        server.onNotification('initialized', () => undefined);
        server.onRequest('shutdown', () => null);
        server.onNotification('exit', () => void child.kill());
        server.onRequest('workspace/executeCommand', () => ({}));
        return child as unknown as ChildProcess;
      };
      return {
        spawnImpl: spawner as unknown as typeof spawn,
        children,
        servers,
        spawnCalls,
      };
    })();

    const proc = new CqlLsProcess({
      javaPath: '/opt/java',
      jarPath: '/jars/cql-ls-server.jar',
      workspacePath: '/work',
      spawnImpl: harness.spawnImpl,
      initializeTimeoutMs: 40,
    });

    try {
      // First crash via initialize timeout (teardownUnexpected sets stopping=true).
      let threw: unknown;
      try {
        await proc.ensureReady();
      } catch (err) {
        threw = err;
      }
      expect(threw).to.be.instanceOf(Error);
      expect(proc.currentState).to.equal('crashed');

      // Allow the second initialize to succeed.
      hangInitialize = false;

      // Respawn — should reach ready (spawnAndInitialize resets stopping=false).
      await proc.executeCommand('cmd', ['x']);
      expect(proc.currentState).to.equal('ready');
      expect(harness.spawnCalls).to.have.length(2);

      // Kill the second child externally. With the fix, stopping was
      // reset to false in spawnAndInitialize, so the exit handler fires
      // handleGone and state becomes 'crashed'. Without the fix, the
      // exit handler sees stopping=true and skips handleGone, leaving
      // state stuck at 'ready'.
      harness.children[1].kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 30));

      expect(proc.currentState).to.equal('crashed');
      expect(proc.crashInfo?.signal).to.equal('SIGKILL');
    } finally {
      await proc.stop();
    }
  });
});