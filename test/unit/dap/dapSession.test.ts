import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { Socket } from 'node:net';
import { DapClient } from '../../../src/dap/dapClient.js';
import { DapSession, isPreviousSessionBusy, type DapStopEvent } from '../../../src/dap/dapSession.js';
import { ContentLengthReader, writeFramed } from '../../../src/dap/framing.js';
import type { CqlLsProcess } from '../../../src/jvm/cqlLsProcess.js';
import type { LspClient } from '../../../src/lsp/lspClient.js';
import { pathToUri } from '../../../src/workspace/paths.js';
import { hostFileUri } from '../../helpers/hostPaths.js';

class FakeLsProcess {
  /** executeCql calls made by the session (the error-collecting re-run). */
  executeCalls: Array<{ command: string; args: unknown[] }> = [];
  executeResponse: unknown = { results: [], logs: [] };
  /** Errors thrown by successive startDebugSession calls before a port is returned. */
  startFailures: unknown[] = [];
  startCalls = 0;

  async ensureReady(): Promise<void> {
    /* no-op */
  }
  async executeCommand(command: string, args: unknown[]): Promise<unknown> {
    this.executeCalls.push({ command, args });
    return this.executeResponse;
  }
  get lspClient(): LspClient {
    return {
      sendExecuteCommand: async (_cmd: string, _args: unknown[]): Promise<unknown> => {
        this.startCalls++;
        const failure = this.startFailures.shift();
        if (failure !== undefined) throw failure;
        return 5678;
      },
      sendNotification: () => undefined,
    } as unknown as LspClient;
  }
}

interface FakeDapSetup {
  session: DapSession;
  ls: FakeLsProcess;
  /** What the test wants the server to send back. */
  server: PassThrough;
  /** What the client wrote; drained by the test. */
  cli: PassThrough;
  sent: object[];
  write: (json: object) => void;
}

function makeFakeSocket(): {
  socket: Socket;
  clientToServer: PassThrough;
  serverToClient: PassThrough;
} {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  // Real sockets emit 'connect' after `net.connect()` resolves. Fake sockets
  // must do the same or DapClient.connect() blocks forever. Emit it on the
  // next tick (after the `await` in client.connect observes the promise).
  const wire = (sock: PassThrough, event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'data') sock.on('data', listener as (chunk: Buffer) => void);
    else if (event === 'end') sock.on('end', listener as () => void);
    else if (event === 'close') sock.on('close', listener as () => void);
    else if (event === 'error') sock.on('error', listener as (err: Error) => void);
  };
  const wireOnce = (sock: PassThrough, event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'data') sock.once('data', listener as (chunk: Buffer) => void);
    else if (event === 'end') sock.once('end', listener as () => void);
    else if (event === 'close') sock.once('close', listener as () => void);
    else if (event === 'error') sock.once('error', listener as (err: Error) => void);
  };
  const unwire = (sock: PassThrough, event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'data') sock.off('data', listener as (chunk: Buffer) => void);
    else if (event === 'end') sock.off('end', listener as () => void);
    else if (event === 'close') sock.off('close', listener as () => void);
    else if (event === 'error') sock.off('error', listener as (err: Error) => void);
  };
  const socket = {
    write: (data: Buffer | string): boolean =>
      clientToServer.write(typeof data === 'string' ? Buffer.from(data) : data),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      wire(serverToClient, event, listener);
      return socket;
    },
    once: (event: string, listener: (...args: unknown[]) => void) => {
      wireOnce(serverToClient, event, listener);
      return socket;
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      unwire(serverToClient, event, listener);
      return socket;
    },
    end: () => serverToClient.end(),
    destroy: () => {
      serverToClient.destroy();
      clientToServer.destroy();
    },
    // Convenience: caller can `await socket.emit('connect')` after attach.
    emit: (event: string): void => {
      if (event === 'connect') serverToClient.emit('connect');
    },
  } as unknown as Socket & { emit: (event: string) => void };
  // Eager-emit 'connect' on next microtask so existing DapClient code paths
  // (which already subscribed via .once('connect')) resolve.
  queueMicrotask(() => serverToClient.emit('connect'));
  return { socket, clientToServer, serverToClient };
}

function makeFakeDap(opts: {
  resumeTimeoutMs?: number;
  startRetryIntervalMs?: number;
  startRetryTimeoutMs?: number;
  stopSocketWaitMs?: number;
}): FakeDapSetup {
  const { socket, clientToServer, serverToClient } = makeFakeSocket();
  const sent: object[] = [];

  let realClient: DapClient | null = null;
  const factory = (): DapClient => {
    if (realClient) throw new Error('factory called twice');
    realClient = new DapClient({ connectImpl: async () => socket });
    return realClient;
  };

  const ls = new FakeLsProcess();
  const session = new DapSession({
    ls: ls as unknown as CqlLsProcess,
    dapClientFactory: factory,
    resumeTimeoutMs: opts.resumeTimeoutMs ?? 50,
    startRetryIntervalMs: opts.startRetryIntervalMs ?? 1,
    startRetryTimeoutMs: opts.startRetryTimeoutMs ?? 50,
    // The fake server never closes the socket after disconnect unless a test does it.
    stopSocketWaitMs: opts.stopSocketWaitMs ?? 5,
  });

  // Use a separate ContentLengthReader to capture the framed JSON the
  // client sent to the (fake) server, so the test can assert on it.
  const reader = new ContentLengthReader(clientToServer);
  reader.onMessage((json) => sent.push(JSON.parse(json)));

  return {
    session,
    ls,
    server: serverToClient,
    cli: clientToServer,
    sent,
    write: (json) => writeFramed(serverToClient, JSON.stringify(json)),
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitUntil: condition not met before timeout');
}

function findSent(setup: FakeDapSetup, command: string): { seq: number } {
  const f = setup.sent.find((m) => (m as { command?: string }).command === command);
  if (!f) throw new Error(`expected command ${command} to have been sent`);
  return f as { seq: number };
}

async function ackRequest(
  setup: FakeDapSetup,
  command: string,
  serverSeq: number,
  body: unknown = {},
  success = true,
): Promise<void> {
  await waitUntil(() => setup.sent.some((m) => (m as { command?: string }).command === command));
  const sent = findSent(setup, command);
  setup.write({
    seq: serverSeq,
    type: 'response',
    request_seq: sent.seq,
    success,
    command,
    body,
    message: success ? undefined : 'failed',
  });
}

async function startSession(setup: FakeDapSetup, cqlFile = '/x/lib.cql'): Promise<void> {
  const promise = setup.session.start({ cqlFile });
  await ackRequest(setup, 'initialize', 9001);
  await ackRequest(setup, 'launch', 9002);
  await ackRequest(setup, 'configurationDone', 9003);
  await promise;
}

async function stopSessionAndAckDisconnect(setup: FakeDapSetup): Promise<void> {
  const stopP = setup.session.stop();
  await waitUntil(() =>
    setup.sent.some((m) => (m as { command?: string }).command === 'disconnect'),
  );
  await ackRequest(setup, 'disconnect', 9100);
  await stopP;
}

describe('dap/dapSession', () => {
  it('starts the chain: initialize → launch → configurationDone', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30 });
    await startSession(setup);
    expect(setup.session.isActive).to.equal(true);
    const commands = setup.sent
      .map((m) => (m as { command?: string }).command)
      .filter((c): c is string => typeof c === 'string');
    expect(commands).to.include.members(['initialize', 'launch', 'configurationDone']);

    const launch = setup.sent.find((m) => (m as { command?: string }).command === 'launch') as {
      arguments: { libraryUri: string; libraryName: string; fhirVersion: string };
    };
    // POSIX-form input: on a Windows host '/x' resolves against the current drive.
    expect(launch.arguments.libraryUri).to.equal(hostFileUri('/x/lib.cql'));
    expect(launch.arguments.libraryName).to.equal('lib');
    expect(launch.arguments.fhirVersion).to.equal('R4');

    await stopSessionAndAckDisconnect(setup);
  });

  it('start() with breakpoints sends setBreakpoints before launch/configurationDone', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30 });
    const promise = setup.session.start({ cqlFile: '/x/lib.cql', breakpoints: [3, 7] });
    await ackRequest(setup, 'initialize', 9001);
    await ackRequest(setup, 'setBreakpoints', 9002, {
      breakpoints: [
        { verified: true, line: 3 },
        { verified: true, line: 7 },
      ],
    });
    await ackRequest(setup, 'launch', 9003);
    await ackRequest(setup, 'configurationDone', 9004);
    await promise;

    const commands = setup.sent
      .map((m) => (m as { command?: string }).command)
      .filter((c): c is string => typeof c === 'string');
    expect(commands.indexOf('setBreakpoints')).to.be.greaterThan(commands.indexOf('initialize'));
    expect(commands.indexOf('setBreakpoints')).to.be.lessThan(commands.indexOf('launch'));
    expect(commands.indexOf('setBreakpoints')).to.be.lessThan(commands.indexOf('configurationDone'));

    const bp = setup.sent.find((m) => (m as { command?: string }).command === 'setBreakpoints') as {
      arguments: { breakpoints: Array<{ line: number }> };
    };
    expect(bp.arguments.breakpoints).to.deep.equal([{ line: 3 }, { line: 7 }]);

    await stopSessionAndAckDisconnect(setup);
  });

  it('start() without breakpoints does not send setBreakpoints', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30 });
    await startSession(setup);
    const commands = setup.sent
      .map((m) => (m as { command?: string }).command)
      .filter((c): c is string => typeof c === 'string');
    expect(commands).to.not.include('setBreakpoints');
    await stopSessionAndAckDisconnect(setup);
  });

  it('enforces single-active-session', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30 });
    await startSession(setup);
    let threw = false;
    try {
      await setup.session.start({ cqlFile: '/x/lib.cql' });
    } catch (err) {
      threw = true;
      expect((err as Error).message).to.match(/already active/);
    }
    expect(threw).to.equal(true);
    await stopSessionAndAckDisconnect(setup);
  });

  it('setBreakpoints sends a DAP setBreakpoints request and returns the response body', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30 });
    await startSession(setup);
    const before = setup.sent.length;
    const promise = setup.session.setBreakpoints('/x/lib.cql', [3, 7]);
    await waitUntil(() => setup.sent.length > before);
    const newOne = setup.sent[setup.sent.length - 1] as {
      seq: number;
      command: string;
      arguments: { source: { name: string; path: string }; breakpoints: Array<{ line: number }> };
    };
    expect(newOne.command).to.equal('setBreakpoints');
    expect(newOne.arguments.breakpoints).to.deep.equal([{ line: 3 }, { line: 7 }]);

    await ackRequest(setup, 'setBreakpoints', 9100, {
      breakpoints: [
        { verified: true, line: 3 },
        { verified: true, line: 7 },
      ],
    });
    const res = await promise;
    expect(res).to.deep.equal([
      { verified: true, line: 3 },
      { verified: true, line: 7 },
    ]);
    await stopSessionAndAckDisconnect(setup);
  });

  it('continue resolves with stopped event and topFrame from stackTrace', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 500 });
    await startSession(setup);

    const promise = setup.session.continue(1);
    await ackRequest(setup, 'continue', 9200);
    setup.write({
      seq: 9201,
      type: 'event',
      event: 'stopped',
      body: { reason: 'breakpoint', threadId: 1 },
    });
    await waitUntil(() =>
      setup.sent.some((m) => (m as { command?: string }).command === 'stackTrace'),
    );
    await ackRequest(setup, 'stackTrace', 9202, {
      stackFrames: [{ id: 11, name: 'Step1', line: 3, source: { name: 'lib.cql' } }],
    });

    const ev: DapStopEvent = await promise;
    expect(ev.event).to.equal('stopped');
    expect(ev.reason).to.equal('breakpoint');
    expect(ev.topFrame?.name).to.equal('Step1');
    expect(ev.topFrame?.line).to.equal(3);
    await stopSessionAndAckDisconnect(setup);
  });

  it('continue resolves with terminated when terminated event fires', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 1000 });
    await startSession(setup);

    const promise = setup.session.continue(1);
    await ackRequest(setup, 'continue', 9300);
    setup.write({ seq: 9301, type: 'event', event: 'terminated', body: {} });
    const ev = await promise;
    expect(ev.event).to.equal('terminated');
    await stopSessionAndAckDisconnect(setup);
  });

  it('ends the session (and sends disconnect) when the debuggee terminates during a resume', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 1000 });
    await startSession(setup);

    const promise = setup.session.continue(1);
    await ackRequest(setup, 'continue', 9310);
    setup.write({ seq: 9311, type: 'event', event: 'terminated', body: {} });
    expect((await promise).event).to.equal('terminated');
    expect(setup.session.isActive).to.equal(false);
    await ackRequest(setup, 'disconnect', 9312);
  });

  it('ends the session when the debuggee terminates outside a resume wait', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 1000 });
    await startSession(setup);

    setup.write({ seq: 9320, type: 'event', event: 'terminated', body: {} });
    await waitUntil(() => !setup.session.isActive);
    await ackRequest(setup, 'disconnect', 9321);
  });

  it('ends the session when the DAP socket closes (e.g. the language server went away)', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 1000 });
    await startSession(setup);

    setup.server.end();
    await waitUntil(() => !setup.session.isActive);
    let message = '';
    try {
      await setup.session.continue(1);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).to.contain('debug session not active');
    // Nothing to stop: cql_debug_stop is a no-op once the session has ended.
    await setup.session.stop();
    expect(setup.sent.some((m) => (m as { command?: string }).command === 'disconnect')).to.equal(false);
  });

  it('continue resolves with timeout when no event arrives before deadline', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 40 });
    await startSession(setup);

    const promise = setup.session.continue(1);
    await ackRequest(setup, 'continue', 9400);

    const ev = await promise;
    expect(ev.event).to.equal('timeout');
    await stopSessionAndAckDisconnect(setup);
  });

  it('scopes / getVariables / evaluate round-trip', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30 });
    await startSession(setup);

    const scopesP = setup.session.scopes(11);
    await ackRequest(setup, 'scopes', 9500, {
      scopes: [{ name: 'Locals', variablesReference: 100, expensive: false }],
    });
    const scopes = await scopesP;
    expect(scopes[0]?.variablesReference).to.equal(100);

    const varsP = setup.session.getVariables(100);
    await ackRequest(setup, 'variables', 9501, {
      variables: [
        { name: 'Step1', value: '10', variablesReference: 0 },
        { name: 'Step2', value: '20', variablesReference: 0 },
      ],
    });
    const vars = await varsP;
    expect(vars).to.have.length(2);

    const evalP = setup.session.evaluate('"Step1" + "Step2"', 11);
    await ackRequest(setup, 'evaluate', 9502, {
      result: '30',
      type: 'Integer',
      variablesReference: 0,
    });
    const res = await evalP;
    expect(res.result).to.equal('30');
    expect(res.type).to.equal('Integer');

    await stopSessionAndAckDisconnect(setup);
  });

  it('stop sends DAP disconnect and disposes client', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30 });
    await startSession(setup);
    const stopP = setup.session.stop();
    await waitUntil(() =>
      setup.sent.some((m) => (m as { command?: string }).command === 'disconnect'),
    );
    await ackRequest(setup, 'disconnect', 9600);
    await stopP;
    expect(setup.session.isActive).to.equal(false);
  });

  it('asserts active when calling step ops before start', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30 });
    let threw = false;
    try {
      await setup.session.continue(1);
    } catch (err) {
      threw = true;
      expect((err as Error).message).to.match(/not active/);
    }
    expect(threw).to.equal(true);
  });

  it('session stays active after a resume timeout (timeout is NOT a teardown)', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30 });
    await startSession(setup);

    const ev = await setup.session.continue(1);
    expect(ev.event).to.equal('timeout');
    // Session must still be active so the caller can retry or inspect state.
    expect(setup.session.isActive).to.equal(true);

    // Sanity: a follow-up non-resume call still works.
    const scopesP = setup.session.scopes(11);
    await ackRequest(setup, 'scopes', 9700, {
      scopes: [{ name: 'Locals', variablesReference: 100, expensive: false }],
    });
    const scopes = await scopesP;
    expect(scopes).to.have.length(1);

    await stopSessionAndAckDisconnect(setup);
  });

  it('late stopped event from a timed-out resume is NOT misattributed to a fresh resume', async () => {
    // Long enough that the 10ms intra-test waits do NOT trip the resume
    // timer for resume B. Resume A is allowed to time out at 30ms.
    const setup = makeFakeDap({ resumeTimeoutMs: 200 });
    await startSession(setup);

    // Resume A: short per-call timeout so it times out fast.
    const aPromise = setup.session.continue(1, 30);
    await ackRequest(setup, 'continue', 9800);
    const aEv = await aPromise;
    expect(aEv.event).to.equal('timeout');

    // Resume B starts. Default 200ms timeout — far longer than our 10ms
    // check, so B is guaranteed to still be pending.
    const bPromise = setup.session.continue(1);
    await waitUntil(() =>
      setup.sent.filter((m) => (m as { command?: string }).command === 'continue').length >= 2,
    );
    await ackRequest(setup, 'continue', 9801);

    // Confirm B is still pending (no stopped event yet).
    let settled = false;
    void bPromise.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).to.equal(false);

    // Now send a stopped event. With the generation-token fix, only B's
    // listener is registered as current, so this event settles B.
    setup.write({
      seq: 9802,
      type: 'event',
      event: 'stopped',
      body: { reason: 'breakpoint', threadId: 1 },
    });
    await waitUntil(() =>
      setup.sent.some((m) => (m as { command?: string }).command === 'stackTrace'),
    );
    await ackRequest(setup, 'stackTrace', 9803, {
      stackFrames: [{ id: 21, name: 'Step3', line: 10, source: { name: 'lib.cql' } }],
    });

    const bEv: DapStopEvent = await bPromise;
    expect(bEv.event).to.equal('stopped');
    expect(bEv.topFrame?.name).to.equal('Step3');
    expect(bEv.topFrame?.line).to.equal(10);

    await stopSessionAndAckDisconnect(setup);
  });


  it('reports cql-virtual paths unchanged in topFrame', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30 });
    await startSession(setup);

    const continuePromise = setup.session.continue(1);
    await waitUntil(() =>
      setup.sent.some((m) => (m as { command?: string }).command === 'continue'),
    );
    await ackRequest(setup, 'continue', 9800);

    setup.write({
      seq: 9801,
      type: 'event',
      event: 'stopped',
      body: { reason: 'breakpoint', threadId: 1 },
    });
    await waitUntil(() =>
      setup.sent.some((m) => (m as { command?: string }).command === 'stackTrace'),
    );
    await ackRequest(setup, 'stackTrace', 9802, {
      stackFrames: [{ id: 21, name: 'Step3', line: 10, source: { path: 'cql-virtual:///FHIRHelpers-4.0.1.cql', name: 'FHIRHelpers-4.0.1.cql' } }],
    });

    const ev: DapStopEvent = await continuePromise;
    expect(ev.event).to.equal('stopped');
    expect(ev.topFrame?.source?.path).to.equal('cql-virtual:///FHIRHelpers-4.0.1.cql');

    await stopSessionAndAckDisconnect(setup);
  });
  it('resumeGeneration increments once per resume() call', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 20 });
    await startSession(setup);

    const g0 = setup.session.resumeGenerationForTest;
    await setup.session.continue(1);
    const g1 = setup.session.resumeGenerationForTest;
    await setup.session.continue(1);
    const g2 = setup.session.resumeGenerationForTest;
    await setup.session.continue(1);
    const g3 = setup.session.resumeGenerationForTest;

    expect(g1).to.equal(g0 + 1);
    expect(g2).to.equal(g1 + 1);
    expect(g3).to.equal(g2 + 1);

    await stopSessionAndAckDisconnect(setup);
  });
});

describe('dap/dapSession — launch defaults and termination reporting', () => {
  // IG Publisher default layout: <ig>/ig.ini, <ig>/input/cql/L.cql, <ig>/input/vocabulary/valueset/.
  let ig: string;
  let cqlFile: string;

  beforeEach(() => {
    ig = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dap-ig-')));
    fs.writeFileSync(path.join(ig, 'ig.ini'), '[IG]\n');
    fs.mkdirSync(path.join(ig, 'input', 'cql'), { recursive: true });
    fs.mkdirSync(path.join(ig, 'input', 'vocabulary', 'valueset'), { recursive: true });
    cqlFile = path.join(ig, 'input', 'cql', 'L.cql');
    fs.writeFileSync(cqlFile, "library L version '1.0.0'\n\ndefine \"A\":\n  1\n");
  });
  afterEach(() => fs.rmSync(ig, { recursive: true, force: true }));

  function launchArgsOf(setup: FakeDapSetup): Record<string, unknown> {
    return (findSent(setup, 'launch') as unknown as { arguments: Record<string, unknown> }).arguments;
  }

  /** Ack the n-th (0-based) request with this command, once it has been sent. */
  async function ackNth(setup: FakeDapSetup, command: string, n: number, serverSeq: number, body: unknown = {}) {
    const ofCommand = () => setup.sent.filter((m) => (m as { command?: string }).command === command);
    await waitUntil(() => ofCommand().length > n);
    const sent = ofCommand()[n] as { seq: number };
    setup.write({ seq: serverSeq, type: 'response', request_seq: sent.seq, success: true, command, body });
  }

  async function startWithBreakpoint(setup: FakeDapSetup, line: number): Promise<void> {
    const promise = setup.session.start({ cqlFile, breakpoints: [line] });
    await ackRequest(setup, 'initialize', 9001);
    await ackRequest(setup, 'setBreakpoints', 9002, { breakpoints: [{ id: 1, verified: true, line }] });
    await ackRequest(setup, 'launch', 9003);
    await ackRequest(setup, 'configurationDone', 9004);
    await promise;
  }

  it('derives rootDir and the default-layout terminologyUri for an IG-layout file', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30 });
    await startSession(setup, cqlFile);
    const args = launchArgsOf(setup);
    expect(args.rootDir).to.equal(pathToUri(ig));
    expect(args.terminologyUri).to.equal(pathToUri(path.join(ig, 'input', 'vocabulary', 'valueset')));
    expect(args).to.not.have.property('optionsPath'); // input/cql/cql-options.json does not exist
    await stopSessionAndAckDisconnect(setup);
  });

  it('sends no rootDir for a file outside an IG', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30 });
    await startSession(setup, '/x/lib.cql');
    expect(launchArgsOf(setup)).to.not.have.property('rootDir');
    await stopSessionAndAckDisconnect(setup);
  });

  it('lets an explicit rootDir override the derived one', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30 });
    const other = path.join(ig, 'other');
    const promise = setup.session.start({ cqlFile, rootDir: other });
    await ackRequest(setup, 'initialize', 9001);
    await ackRequest(setup, 'launch', 9002);
    await ackRequest(setup, 'configurationDone', 9003);
    await promise;
    expect(launchArgsOf(setup).rootDir).to.equal(pathToUri(other));
    await stopSessionAndAckDisconnect(setup);
  });

  it('reports "terminated (no breakpoints set)" without re-running the library', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 1000 });
    await startSession(setup, cqlFile);
    const promise = setup.session.continue(1);
    await ackRequest(setup, 'continue', 9300);
    setup.write({ seq: 9301, type: 'event', event: 'terminated', body: {} });
    const ev = await promise;
    expect(ev.event).to.equal('terminated');
    expect(ev.note).to.equal('terminated (no breakpoints set)');
    expect(setup.ls.executeCalls).to.have.length(0);
    await ackRequest(setup, 'disconnect', 9302);
  });

  it('when breakpoints were set but none was hit, reports unverified breakpoints and the library errors', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 1000 });
    setup.ls.executeResponse = {
      results: [{ libraryName: 'L', expressions: [{ name: 'Error', value: 'Could not load model information' }] }],
      logs: [],
    };
    await startWithBreakpoint(setup, 3);
    // The LS later marks a non-breakpointable line (here the `define` line) unverified.
    setup.write({
      seq: 9200,
      type: 'event',
      event: 'breakpoint',
      body: { reason: 'changed', breakpoint: { id: 1, verified: false, line: 3, source: { path: cqlFile } } },
    });
    const promise = setup.session.continue(1);
    await ackRequest(setup, 'continue', 9300);
    setup.write({ seq: 9301, type: 'event', event: 'terminated', body: {} });
    const ev = await promise;
    expect(ev.event).to.equal('terminated');
    expect(ev.note).to.contain('terminated without stopping');
    expect(ev.unverifiedBreakpoints).to.deep.equal([{ line: 3, path: cqlFile }]);
    expect(ev.errors).to.deep.equal(['Could not load model information']);
    // The re-run uses the launch's request shape, including the derived IG root.
    expect(setup.ls.executeCalls).to.have.length(1);
    const request = setup.ls.executeCalls[0]!.args[0] as { rootDir: string | null };
    expect(request.rootDir).to.equal(pathToUri(ig));
    await ackRequest(setup, 'disconnect', 9302);
  });

  it('adds nothing when the session stopped before it terminated', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 1000 });
    await startWithBreakpoint(setup, 4);
    const first = setup.session.continue(1);
    await ackNth(setup, 'continue', 0, 9300);
    setup.write({ seq: 9301, type: 'event', event: 'stopped', body: { reason: 'breakpoint', threadId: 1 } });
    await ackNth(setup, 'stackTrace', 0, 9302, { stackFrames: [{ id: 1, name: 'A', line: 4 }] });
    expect((await first).event).to.equal('stopped');

    const second = setup.session.continue(1);
    await ackNth(setup, 'continue', 1, 9303);
    setup.write({ seq: 9304, type: 'event', event: 'terminated', body: {} });
    const ev = await second;
    expect(ev).to.deep.equal({ event: 'terminated' });
    expect(setup.ls.executeCalls).to.have.length(0);
    await ackRequest(setup, 'disconnect', 9305);
  });
});

describe('dap/dapSession — restart while the previous session shuts down', () => {
  // What the LS sends while its previous session is still closing (observed with the b623850 jar):
  // a generic JSON-RPC internal error whose data carries the stack trace naming the cause.
  const busy = () => ({
    code: -32603,
    message: 'Internal error.',
    data:
      'java.util.concurrent.CompletionException: java.lang.IllegalStateException: Please wait for the ' +
      'current debug session to end before starting a new one.\n\tat ...',
  });

  it('recognizes only the LS refusal for a session that is still shutting down', () => {
    expect(isPreviousSessionBusy(busy())).to.equal(true);
    expect(isPreviousSessionBusy({ ...busy(), code: -32600 })).to.equal(false);
    expect(isPreviousSessionBusy({ ...busy(), data: 'java.lang.NullPointerException' })).to.equal(false);
    expect(isPreviousSessionBusy(new Error('boom'))).to.equal(false);
    expect(isPreviousSessionBusy(undefined)).to.equal(false);
  });

  it('retries startDebugSession until the previous session has ended', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30 });
    setup.ls.startFailures = [busy(), busy()];
    await startSession(setup);
    expect(setup.ls.startCalls).to.equal(3);
    expect(setup.session.isActive).to.equal(true);
    await stopSessionAndAckDisconnect(setup);
  });

  it('gives a clear error when the previous session never ends within the bound', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30, startRetryIntervalMs: 2, startRetryTimeoutMs: 20 });
    setup.ls.startFailures = Array.from({ length: 1000 }, busy);
    let message = '';
    try {
      await setup.session.start({ cqlFile: '/x/lib.cql' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).to.contain('previous debug session still shutting down after 0.02 s');
    expect(setup.ls.startCalls).to.be.greaterThan(1);
    expect(setup.session.isActive).to.equal(false);
  });

  it('does not retry other startDebugSession errors', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30 });
    setup.ls.startFailures = [new Error('boom')];
    let message = '';
    try {
      await setup.session.start({ cqlFile: '/x/lib.cql' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).to.equal('boom');
    expect(setup.ls.startCalls).to.equal(1);
  });

  it('stop resolves as soon as the LS closes the socket after disconnect', async () => {
    const setup = makeFakeDap({ resumeTimeoutMs: 30, stopSocketWaitMs: 5000 });
    await startSession(setup);
    const t0 = Date.now();
    const stopP = setup.session.stop();
    await ackRequest(setup, 'disconnect', 9700);
    setup.server.end();
    await stopP;
    expect(Date.now() - t0).to.be.lessThan(1000);
  });
});
