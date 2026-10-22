import { EventEmitter } from 'node:events';
import { connect as netConnect, type Socket } from 'node:net';
import { ContentLengthReader, writeFramed } from './framing.js';
import { log } from '../log.js';

/** Raw DAP frame as defined by the Debug Adapter Protocol. */
export interface DapMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  event?: string;
  arguments?: unknown;
  body?: unknown;
  success?: boolean;
  message?: string;
  request_seq?: number;
}

export interface DapResponse {
  command: string;
  success: boolean;
  body?: unknown;
  message?: string;
  request_seq: number;
}

export class DapError extends Error {
  readonly command: string;
  constructor(message: string, command: string) {
    super(message);
    this.name = 'DapError';
    this.command = command;
  }
}

/**
 * Minimal DAP client. Connects to a TCP port, sends/receives Content-Length
 * framed JSON, correlates request/response by `seq`/`request_seq`, and emits
 * server-pushed events via `EventEmitter`. Server-to-client requests (e.g.
 * runInTerminal) are emitted as a single 'serverRequest' event.
 */
export interface DapClientOptions {
  /** Injectable transport for tests; defaults to `net.connect(port, '127.0.0.1')`. */
  connectImpl?: (port: number) => Promise<Socket>;
  /** Connect-timeout in milliseconds. Defaults to 10_000 to match the
   *  server-side 10s accept window in CqlDebugServer. */
  connectTimeoutMs?: number;
  /** Default per-request timeout in milliseconds for `send()`. Defaults to
   *  60_000 — generous because `launch` involves compile + parse + first
   *  evaluation and can legitimately take tens of seconds. Kept above
   *  DapSession's resume-op timeout (default 30_000) so a dead adapter's
   *  resume timeout fires first, keeping outcomes deterministic. */
  requestTimeoutMs?: number;
}

export interface DapSendOptions {
  /** Overrides `requestTimeoutMs` for this call only. */
  timeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class DapClient extends EventEmitter {
  private socket: Socket | null = null;
  private reader: ContentLengthReader | null = null;
  private nextSeq = 1;
  private pending = new Map<
    number,
    {
      resolve: (v: DapResponse) => void;
      reject: (e: Error) => void;
      command: string;
      timer: NodeJS.Timeout;
    }
  >();
  private disposed = false;
  private closed = false;
  private readonly connectImpl: (port: number) => Promise<Socket>;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(opts: DapClientOptions = {}) {
    super();
    this.connectImpl =
      opts.connectImpl ??
      ((port: number) =>
        new Promise<Socket>((resolve, reject) => {
          const sock = netConnect(port, '127.0.0.1');
          const onError = (err: Error): void => {
            sock.off('connect', onConnect);
            reject(err);
          };
          const onConnect = (): void => {
            sock.off('error', onError);
            resolve(sock);
          };
          sock.once('error', onError);
          sock.once('connect', onConnect);
        }));
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async connect(port: number): Promise<void> {
    if (this.socket) {
      throw new Error('DAP client already connected');
    }
    let timer: NodeJS.Timeout | undefined;
    const connectPromise = this.connectImpl(port);
    try {
      const sock = await Promise.race<Socket>([
        connectPromise,
        new Promise<Socket>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `DAP connect to port ${port} timed out after ${this.connectTimeoutMs}ms`,
              ),
            );
          }, this.connectTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      this.socket = sock;
      this.reader = new ContentLengthReader(sock);
      this.reader.onMessage((json) => this.handleFrame(json));
      this.reader.onEnd(() => this.handleSocketClosed('end'));
    } catch (err) {
      if (timer) clearTimeout(timer);
      // If connectImpl eventually resolves despite the timeout, destroy the
      // stray socket so we don't leak an open file descriptor. We attach a
      // no-op 'error' listener first to harden against an 'error' event
      // firing in the microtask gap between connectPromise resolving and
      // our cleanup handler running — Node treats an unhandled 'error'
      // event as fatal. We only attach this on the catch path, so the
      // success path never double-destroys.
      connectPromise.then(
        (sock) => {
          sock.on('error', () => undefined);
          sock.destroy();
        },
        () => undefined,
      );
      throw err;
    }
  }

  isConnected(): boolean {
    return this.socket !== null && !this.disposed && !this.closed;
  }

  async send(command: string, args?: unknown, opts: DapSendOptions = {}): Promise<DapResponse> {
    if (!this.socket || this.disposed || this.closed) {
      throw new Error('DAP client not connected');
    }
    const seq = this.nextSeq++;
    const message: DapMessage = { seq, type: 'request', command, arguments: args };
    const json = JSON.stringify(message);
    const timeoutMs = opts.timeoutMs ?? this.requestTimeoutMs;
    log.debug(`DAP -> ${command} (seq=${seq})`);
    return new Promise<DapResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`DAP request '${command}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, command, timer });
      try {
        writeFramed(this.socket!, json);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleFrame(json: string): void {
    let msg: DapMessage;
    try {
      msg = JSON.parse(json) as DapMessage;
    } catch (err) {
      log.warn('DAP frame failed to parse', {
        message: err instanceof Error ? err.message : String(err),
        preview: json.slice(0, 80),
      });
      return;
    }

    if (msg.type === 'response') {
      const requestSeq = msg.request_seq;
      const pending = requestSeq !== undefined ? this.pending.get(requestSeq) : undefined;
      if (!pending) {
        log.warn('DAP response with no pending request', { requestSeq });
        return;
      }
      this.pending.delete(requestSeq!);
      clearTimeout(pending.timer);
      if (msg.success) {
        pending.resolve({
          command: pending.command,
          success: true,
          body: msg.body,
          message: msg.message,
          request_seq: requestSeq!,
        });
      } else {
        pending.reject(new DapError(msg.message ?? 'DAP request failed', pending.command));
      }
      return;
    }

    if (msg.type === 'event') {
      if (msg.event) {
        if (msg.event === 'output') {
          // Sink DAP output (Debug Console messages) to MCP stderr rather
          // than surfacing in tool responses — mirrors VS Code's separate
          // Debug Console channel.
          log.debug(`[dap output] ${previewOutput(msg.body)}`);
        }
        this.emit(msg.event, msg);
      }
      this.emit('event', msg);
      return;
    }

    if (msg.type === 'request') {
      // Server-to-client requests (e.g. runInTerminal). Surfaced for
      // completeness; the CQL DAP server does not currently emit any.
      this.emit('serverRequest', msg);
    }
  }

  private handleSocketClosed(_reason: 'end'): void {
    // Mark closed so a subsequent send() (e.g. the LS-side debug session
    // exiting and closing the TCP socket between a caller's requests) fails
    // fast instead of queuing a request that can never be answered — the
    // socket has already emitted its terminal 'end'/'close' event, so no
    // response or further 'end'/'close' will ever arrive to reject it.
    this.closed = true;
    const err = new Error('DAP socket closed');
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emit('end');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const err = new Error('DAP client disposed');
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    try {
      this.reader?.dispose();
    } catch {
      /* ignore */
    }
    this.reader = null;
    try {
      this.socket?.end();
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.emit('disposed');
  }
}

function previewOutput(body: unknown): string {
  if (!body || typeof body !== 'object') return String(body);
  const output = body as { output?: unknown; category?: unknown };
  const category = typeof output.category === 'string' ? output.category : 'console';
  const text = typeof output.output === 'string' ? output.output : '';
  return `[${category}] ${text}`.slice(0, 400);
}
