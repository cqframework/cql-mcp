import {
  createMessageConnection,
  MessageConnection,
  MessageReader,
  MessageWriter,
} from 'vscode-jsonrpc/node';
import {
  ExecuteCommandParams,
  ExecuteCommandRequest,
  WorkspaceFolder,
} from 'vscode-languageserver-protocol';
import { SERVER_NAME } from '../version.js';

export class LspClient {
  /**
   * In-flight request promises. We track them so dispose() can drain them
   * with a no-op .catch() before calling connection.dispose(); otherwise
   * vscode-jsonrpc rejects every pending request with
   * "Pending response rejected since connection got disposed", and those
   * rejections surface as uncaughtException / unhandledRejection during
   * crash teardown (e.g. when an in-flight `initialize` is orphaned by a
   * Promise.race timeout and the connection is then disposed).
   */
  private readonly inflight = new Set<Promise<unknown>>();

  private constructor(private readonly connection: MessageConnection) {}

  static create(
    reader: MessageReader,
    writer: MessageWriter,
  ): { client: LspClient; connection: MessageConnection } {
    const connection = createMessageConnection(reader, writer);
    connection.listen();
    return { client: new LspClient(connection), connection };
  }

  onClose(listener: () => void): void {
    this.connection.onClose(listener);
  }

  onError(
    listener: (data: [Error, unknown, number | undefined]) => void,
  ): void {
    this.connection.onError(listener);
  }

  async initialize(workspaceFolders?: WorkspaceFolder[]): Promise<void> {
    await this.track(
      this.connection.sendRequest('initialize', {
        processId: process.pid,
        clientInfo: { name: SERVER_NAME },
        capabilities: {},
        ...(workspaceFolders ? { workspaceFolders } : {}),
      }),
      'initialize',
    );
    this.connection.sendNotification('initialized', {});
  }

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    return this.track(
      this.connection.sendRequest(method, params),
      `sendRequest(${method})`,
    );
  }

  sendNotification(method: string, params?: unknown): void {
    this.connection.sendNotification(method, params);
  }

  async sendExecuteCommand(
    command: string,
    args: unknown[],
  ): Promise<unknown> {
    const params: ExecuteCommandParams = { command, arguments: args };
    return this.track(
      this.connection.sendRequest(ExecuteCommandRequest.type.method, params),
      `sendExecuteCommand(${command})`,
    );
  }

  /**
   * Register a vscode-jsonrpc request promise so dispose() can drain it
   * with a no-op .catch() before tearing down the connection. The promise
   * is removed from the set when it settles (either way).
   */
  private track<T>(promise: Promise<T>, label: string): Promise<T> {
    this.inflight.add(promise);
    const tracked = promise as Promise<T> & { __lspLabel?: string };
    tracked.__lspLabel = label;
    const cleanup = (): void => {
      this.inflight.delete(promise);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  dispose(): void {
    // Attach a no-op .catch() to every in-flight request BEFORE we ask
    // vscode-jsonrpc to dispose. Without this, the dispose call rejects
    // each pending request with "Pending response rejected since connection
    // got disposed", and those rejections become unhandled — which the
    // test runner treats as a failure and which in production would show
    // up as noisy crash-time errors.
    for (const p of this.inflight) {
      p.catch(() => undefined);
    }
    this.inflight.clear();
    try {
      this.connection.dispose();
    } catch {
      /* ignore teardown errors */
    }
  }
}
