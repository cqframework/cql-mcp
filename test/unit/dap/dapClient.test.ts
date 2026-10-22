import { expect } from 'chai';
import { PassThrough } from 'node:stream';
import { Socket } from 'node:net';
import type { DapResponse } from '../../../src/dap/dapClient.js';
import { DapClient, DapError } from '../../../src/dap/dapClient.js';
import { ContentLengthReader, writeFramed } from '../../../src/dap/framing.js';

interface FakeSocket {
  socket: Socket;
  /** What the client wrote — caller drains this. */
  clientToServer: PassThrough;
  /** What the test wants the server to send back — caller writes to this. */
  serverToClient: PassThrough;
}

function makeFakeSocket(): FakeSocket {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const socket = {
    write: (data: Buffer | string): boolean => {
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      return clientToServer.write(buf);
    },
    on(event: string, listener: (...args: unknown[]) => void): FakeSocket['socket'] {
      // Forward lifecycle events from the inbound side so DapClient sees EOF.
      if (event === 'data') serverToClient.on('data', listener as (chunk: Buffer) => void);
      if (event === 'end') serverToClient.on('end', listener as () => void);
      if (event === 'close') serverToClient.on('close', listener as () => void);
      if (event === 'error') serverToClient.on('error', listener as (err: Error) => void);
      return socket;
    },
    once(event: string, listener: (...args: unknown[]) => void): FakeSocket['socket'] {
      if (event === 'data') serverToClient.once('data', listener as (chunk: Buffer) => void);
      if (event === 'end') serverToClient.once('end', listener as () => void);
      if (event === 'close') serverToClient.once('close', listener as () => void);
      if (event === 'error') serverToClient.once('error', listener as (err: Error) => void);
      return socket;
    },
    off(event: string, listener: (...args: unknown[]) => void): FakeSocket['socket'] {
      if (event === 'data') serverToClient.off('data', listener as (chunk: Buffer) => void);
      if (event === 'end') serverToClient.off('end', listener as () => void);
      if (event === 'close') serverToClient.off('close', listener as () => void);
      if (event === 'error') serverToClient.off('error', listener as (err: Error) => void);
      return socket;
    },
    end: () => {
      serverToClient.end();
    },
    destroy: () => {
      serverToClient.destroy();
      clientToServer.destroy();
    },
  } as unknown as Socket;
  return { socket, clientToServer, serverToClient };
}

function makeClient(): {
  client: DapClient;
  server: PassThrough;
  cli: PassThrough;
  sent: Array<Record<string, unknown>>;
} {
  const { socket, clientToServer, serverToClient } = makeFakeSocket();
  const client = new DapClient({ connectImpl: async () => socket });
  const sent: Array<Record<string, unknown>> = [];
  const reader = new ContentLengthReader(clientToServer);
  reader.onMessage((json) => {
    sent.push(JSON.parse(json));
  });
  return { client, server: serverToClient, cli: clientToServer, sent };
}

function serverRespond(server: PassThrough, requestSeq: number, body: unknown, success = true): void {
  writeFramed(
    server,
    JSON.stringify({
      seq: requestSeq,
      type: 'response',
      request_seq: requestSeq,
      success,
      command: 'test',
      body,
      message: success ? undefined : 'failed',
    }),
  );
}

function serverEvent(server: PassThrough, event: string, body: unknown = {}): void {
  writeFramed(
    server,
    JSON.stringify({
      seq: 1000,
      type: 'event',
      event,
      body,
    }),
  );
}

describe('dap/dapClient', () => {
  it('correlates request/response by seq and resolves pending', async () => {
    const { client, server, sent } = makeClient();

    await client.connect(0);

    const pending = client.send('initialize', { x: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[0]).to.include({ seq: 1, type: 'request', command: 'initialize' });

    serverRespond(server, 1, { capabilities: {} });
    const res = (await pending) as DapResponse;
    expect(res.success).to.equal(true);
    expect(res.body).to.deep.equal({ capabilities: {} });
    await client.dispose();
  });

  it('rejects with DapError on unsuccessful response', async () => {
    const { client, server } = makeClient();
    await client.connect(0);

    const pending = client.send('launch', {});
    await new Promise((r) => setTimeout(r, 10));
    serverRespond(server, 1, undefined, false);
    let caught: unknown;
    try {
      await pending;
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(DapError);
    await client.dispose();
  });

  it('emits server events by name', async () => {
    const { client, server } = makeClient();
    await client.connect(0);

    const ev = await new Promise<Record<string, unknown>>((resolve) => {
      client.on('stopped', (m: Record<string, unknown>) => resolve(m));
      serverEvent(server, 'stopped', { reason: 'breakpoint', threadId: 1 });
    });

    expect(ev.event).to.equal('stopped');
    expect((ev.body as { reason?: string } | undefined)?.reason).to.equal('breakpoint');
    await client.dispose();
  });

  it('send() rejects with a timeout error when no response arrives', async () => {
    const { client } = makeClient();
    await client.connect(0);

    const start = Date.now();
    let caught: unknown;
    try {
      await client.send('launch', {}, { timeoutMs: 50 });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include("DAP request 'launch' timed out");
    expect((caught as Error).message).to.include('50ms');
    expect(elapsed).to.be.greaterThanOrEqual(45);
    expect(elapsed).to.be.lessThan(500);
    await client.dispose();
  });

  it('rejects pending requests when the socket closes', async () => {
    const { client, server } = makeClient();
    await client.connect(0);

    const pending = client.send('setBreakpoints', {});
    await new Promise((r) => setTimeout(r, 10));
    server.end();
    let caught: unknown;
    try {
      await pending;
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(Error);
  });

  it('send() after the socket has already closed rejects immediately, not after a timeout', async () => {
    // Regression test: the LS-side debug session can exit and close its end
    // of the TCP socket between two caller requests (e.g. the debuggee ran
    // to completion right after `continue`). Before this fix, a `send()`
    // issued after that close was silently queued forever — isConnected()
    // and send()'s guard only checked `disposed`, not whether the socket had
    // already emitted its terminal 'end'/'close' event — so nothing would
    // ever reject it except a bounded request timeout. It should instead
    // fail fast.
    const { client, server } = makeClient();
    await client.connect(0);
    expect(client.isConnected()).to.equal(true);

    server.end();
    await new Promise((r) => setTimeout(r, 10));
    expect(client.isConnected()).to.equal(false);

    const start = Date.now();
    let caught: unknown;
    try {
      await client.send('setBreakpoints', {}, { timeoutMs: 5000 });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include('not connected');
    expect(elapsed).to.be.lessThan(500);
    await client.dispose();
  });

  it('rejects pending requests on dispose', async () => {
    const { client } = makeClient();
    await client.connect(0);
    const pending = client.send('whatever', {});
    await new Promise((r) => setTimeout(r, 10));
    await client.dispose();
    let caught: unknown;
    try {
      await pending;
    } catch (err) {
      caught = err;
    }
    expect(caught).to.be.instanceOf(Error);
  });

  it('refuses a second connect', async () => {
    const { client } = makeClient();
    await client.connect(0);
    let threw = false;
    try {
      await client.connect(0);
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
    await client.dispose();
  });

  it('connect() rejects with a timeout error when the socket never connects', async () => {
    // Inject a connectImpl whose Promise never resolves — simulates a
    // stuck firewall or unaccepted LS-side accept() window.
    const start = Date.now();
    const client = new DapClient({
      connectImpl: () => new Promise<Socket>(() => undefined),
      connectTimeoutMs: 50,
    });

    let caught: unknown;
    try {
      await client.connect(0);
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;

    expect(caught).to.be.instanceOf(Error);
    expect((caught as Error).message).to.include('timed out');
    expect((caught as Error).message).to.include('50ms');
    expect(elapsed).to.be.greaterThanOrEqual(45);
    expect(elapsed).to.be.lessThan(500);
    expect(client.isConnected()).to.equal(false);
    await client.dispose();
  });

  it('destroys a stray socket if the underlying connect() resolves after the timeout', async () => {
    // Regression test for the socket-leak gap: when the timer wins the
    // Promise.race against connectImpl, the in-flight connectImpl may
    // still resolve later (e.g. server accept() was slow but completed
    // at 10.5s against a 10s client timeout). Without cleanup, that
    // stray Socket leaks an open file descriptor. The fix attaches a
    // cleanup .then() to the in-flight connectImpl promise on the
    // catch path, destroying the socket when it eventually materializes.
    let resolveConnect: (sock: Socket) => void = () => undefined;
    const lateSocket = new Socket();
    const connectImpl = (_port: number): Promise<Socket> =>
      new Promise<Socket>((resolve) => {
        resolveConnect = resolve;
        // Simulate: connectImpl's promise resolves 150ms after the timeout
        // fires at 50ms. This models the "slow accept" scenario.
        setTimeout(() => resolveConnect(lateSocket), 150);
      });

    const client = new DapClient({ connectImpl, connectTimeoutMs: 50 });
    let threw: unknown;
    try {
      // Port argument is unused by the mock but required by the API.
      await client.connect(0);
    } catch (err) {
      threw = err;
    }
    expect(threw).to.be.instanceOf(Error);
    expect((threw as Error).message).to.include('timed out');
    expect(client.isConnected()).to.equal(false);

    // Wait past the simulated late resolution so the cleanup .then()
    // has a chance to fire.
    await new Promise((r) => setTimeout(r, 200));
    expect(lateSocket.destroyed).to.equal(true);

    lateSocket.destroy();
    await client.dispose();
  });
});