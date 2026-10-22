import { expect } from 'chai';
import { PassThrough } from 'node:stream';
import type { Socket } from 'node:net';
import { DapClient } from '../../../src/dap/dapClient.js';
import { DapSession, type DapStopEvent } from '../../../src/dap/dapSession.js';
import { ContentLengthReader, writeFramed } from '../../../src/dap/framing.js';
import type { CqlLsProcess } from '../../../src/jvm/cqlLsProcess.js';
import type { LspClient } from '../../../src/lsp/lspClient.js';

class FakeLsProcess {
  async ensureReady(): Promise<void> {
    /* no-op */
  }
  get lspClient(): LspClient {
    return {
      sendExecuteCommand: async (_cmd: string, _args: unknown[]): Promise<unknown> => 5678,
    } as unknown as LspClient;
  }
}

interface FakeDapSetup {
  session: DapSession;
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

function makeFakeDap(opts: { resumeTimeoutMs?: number }): FakeDapSetup {
  const { socket, clientToServer, serverToClient } = makeFakeSocket();
  const sent: object[] = [];

  let realClient: DapClient | null = null;
  const factory = (): DapClient => {
    if (realClient) throw new Error('factory called twice');
    realClient = new DapClient({ connectImpl: async () => socket });
    return realClient;
  };

  const session = new DapSession({
    ls: new FakeLsProcess() as unknown as CqlLsProcess,
    dapClientFactory: factory,
    resumeTimeoutMs: opts.resumeTimeoutMs ?? 50,
  });

  // Use a separate ContentLengthReader to capture the framed JSON the
  // client sent to the (fake) server, so the test can assert on it.
  const reader = new ContentLengthReader(clientToServer);
  reader.onMessage((json) => sent.push(JSON.parse(json)));

  return {
    session,
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
    expect(launch.arguments.libraryUri).to.equal('file:///x/lib.cql');
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
