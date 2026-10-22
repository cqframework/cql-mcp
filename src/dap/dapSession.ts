import type { CqlLsProcess } from '../jvm/cqlLsProcess.js';
import { startDebugSession } from '../lsp/lspCommands.js';
import { DapClient, DapError, type DapResponse } from './dapClient.js';
import { libraryNameOf, pathToUri } from '../workspace/paths.js';
import { log } from '../log.js';

export type StepGranularity = 'ast' | 'cql';

export interface DebugLaunchArgs {
  cqlFile: string;
  fhirVersion?: string;
  testCaseName?: string;
  testCaseDir?: string;
  terminologyUri?: string;
  rootDir?: string;
  optionsPath?: string;
  parameters?: Record<string, unknown>;
  stepGranularity?: StepGranularity;
  /** 1-indexed line numbers to set on `cqlFile` before `launch`/`configurationDone`.
   *  Uses the LS's pre-launch breakpoints fallback (path-keyed, migrated once
   *  `launch` resolves the library) — this is not DAP spec order (spec order is
   *  launch before setBreakpoints), but it lets callers avoid a second
   *  cql_debug_set_breakpoints round-trip in the common case. */
  breakpoints?: number[];
}

export interface DapStackFrame {
  id: number;
  name: string;
  line: number;
  source?: { name?: string; path?: string };
}

export interface DapStopEvent {
  event: 'stopped' | 'terminated' | 'timeout';
  reason?: string;
  threadId?: number;
  topFrame?: DapStackFrame;
}

export interface DapScope {
  name: string;
  variablesReference: number;
  expensive: boolean;
}

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

export interface DapEvaluationResult {
  result: string;
  type?: string;
  variablesReference: number;
}

export interface DapSessionOptions {
  ls: CqlLsProcess;
  /** Injectable factory used by tests; defaults to a real DapClient. */
  dapClientFactory?: () => DapClient;
  /** Default resume-op wait (continue/next/step*). Per-call override available. */
  resumeTimeoutMs?: number;
}

const DEFAULT_RESUME_TIMEOUT_MS = 30_000;

export class DapSession {
  protected readonly ls: CqlLsProcess;
  protected readonly dapClientFactory: () => DapClient;
  protected defaultResumeTimeoutMs: number;
  protected client: DapClient | null = null;
  /**
   * Monotonic counter incremented on every resume() call. Each resume race
   * captures its own generation in a closure; listeners and the timer gate
   * themselves on `myGeneration === resumeGeneration` so a late `stopped`
   * event from a prior (timed-out or already-settled) resume cannot be
   * picked up by a fresh resume's listener. The session itself stays valid
   * across generations — a timeout does NOT tear down the client.
   */
  protected resumeGeneration = 0;

  constructor(opts: DapSessionOptions) {
    this.ls = opts.ls;
    this.dapClientFactory = opts.dapClientFactory ?? (() => new DapClient());
    this.defaultResumeTimeoutMs = opts.resumeTimeoutMs ?? DEFAULT_RESUME_TIMEOUT_MS;
  }

  get isActive(): boolean {
    return this.client !== null;
  }

  /** Test-only accessor for the resume generation counter. */
  get resumeGenerationForTest(): number {
    return this.resumeGeneration;
  }

  /**
   * Chains (in a single tool call): LSP `startDebugSession` → read port → dial
   * TCP → DAP `initialize` → DAP `launch` → DAP `configurationDone`. The 10s
   * LS-side accept window must be hit by the TCP connect — splitting this into
   * two MCP calls risks the window elapsing between them.
   */
  async start(args: DebugLaunchArgs): Promise<void> {
    if (this.isActive) {
      throw new Error('debug session already active; call cql_debug_stop first');
    }
    await this.ls.ensureReady();

    const port = await startDebugSession(this.ls.lspClient);
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
      throw new Error(`startDebugSession returned invalid port: ${JSON.stringify(port)}`);
    }
    log.info('DAP dial', { port });

    const client = this.dapClientFactory();
    try {
      await client.connect(port);
    } catch (err) {
      log.error('DAP connect failed', {
        port,
        message: err instanceof Error ? err.message : String(err),
      });
      await client.dispose();
      throw new Error(
        `Failed to connect to debug session port ${port} (the 10s accept window may have elapsed). ` +
          `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      await client.send('initialize', {
        clientID: 'mcp-cql-debug',
        adapterID: 'cql-ls',
        locale: 'en-US',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path',
        supportsVariableType: true,
        supportsVariablePaging: false,
        supportsRunInTerminalRequest: false,
      });
      if (args.breakpoints && args.breakpoints.length > 0) {
        await this.sendSetBreakpoints(client, args.cqlFile, args.breakpoints);
      }
      // The LS gates `launch` on `configurationDone` (see
      // CqlDebugServer.kt:135-138). VS Code sends them back-to-back without
      // waiting for the launch response. We mirror that: fire
      // configurationDone concurrently with the launch send so the LS sees
      // both before launch's configuredFuture can complete.
      const launchArgs = this.buildLaunchArgs(args);
      const launchP = client.send('launch', launchArgs);
      const cfgP = client.send('configurationDone', {});
      await Promise.all([launchP, cfgP]);
      this.client = client;
      this.endWhenFinished(client);
      log.info('DAP session launched', { cqlFile: args.cqlFile });
    } catch (err) {
      await client.dispose();
      throw err;
    }
  }

  async setBreakpoints(
    cqlFile: string,
    lines: number[],
  ): Promise<Array<{ verified: boolean; line: number; source?: { name?: string; path?: string } }>> {
    this.assertActive();
    return this.sendSetBreakpoints(this.client!, cqlFile, lines);
  }

  private async sendSetBreakpoints(
    client: DapClient,
    cqlFile: string,
    lines: number[],
  ): Promise<Array<{ verified: boolean; line: number; source?: { name?: string; path?: string } }>> {
    const res = await client.send('setBreakpoints', {
      source: { name: libraryNameOf(cqlFile), path: cqlFile },
      breakpoints: lines.map((line) => ({ line })),
    });
    const body = res.body as { breakpoints?: Array<{ verified: boolean; line: number }> } | undefined;
    return body?.breakpoints ?? [];
  }

  async continue(threadId = 1, timeoutMs?: number): Promise<DapStopEvent> {
    return this.resume('continue', threadId, timeoutMs);
  }

  async next(threadId = 1, timeoutMs?: number): Promise<DapStopEvent> {
    return this.resume('next', threadId, timeoutMs);
  }

  async stepIn(threadId = 1, timeoutMs?: number): Promise<DapStopEvent> {
    return this.resume('stepIn', threadId, timeoutMs);
  }

  async stepOut(threadId = 1, timeoutMs?: number): Promise<DapStopEvent> {
    return this.resume('stepOut', threadId, timeoutMs);
  }

  async scopes(frameId: number): Promise<DapScope[]> {
    this.assertActive();
    const res = await this.client!.send('scopes', { frameId });
    const body = res.body as { scopes?: DapScope[] } | undefined;
    return body?.scopes ?? [];
  }

  async getVariables(variablesReference: number): Promise<DapVariable[]> {
    this.assertActive();
    const res = await this.client!.send('variables', { variablesReference });
    const body = res.body as { variables?: DapVariable[] } | undefined;
    return body?.variables ?? [];
  }

  async evaluate(
    expression: string,
    frameId?: number,
  ): Promise<DapEvaluationResult> {
    this.assertActive();
    const res = await this.client!.send('evaluate', {
      expression,
      frameId,
      context: frameId !== undefined ? 'repl' : 'hover',
    });
    return res.body as DapEvaluationResult;
  }

  async stop(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try {
      await client.send('disconnect', { terminateDebuggee: true });
    } catch (err) {
      log.warn('DAP disconnect failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    await client.dispose();
    log.info('DAP session stopped');
  }

  /**
   * Ends the session once the debuggee is done or the DAP connection is gone, so `isActive` goes
   * false and cql_debug_start works again without a cql_debug_stop first. On `terminated`/`exited`
   * the session is stopped normally (DAP expects the client to send `disconnect`). On socket close
   * (for example the language server went away) there is no one to disconnect from, so the client
   * is just disposed. Events from an earlier session's client are ignored.
   */
  private endWhenFinished(client: DapClient): void {
    const onDone = (): void => {
      if (this.client === client) {
        void this.stop();
      }
    };
    client.once('terminated', onDone);
    client.once('exited', onDone);
    client.once('end', () => {
      if (this.client !== client) return;
      this.client = null;
      void client.dispose();
      log.info('DAP session ended: socket closed');
    });
  }

  private buildLaunchArgs(args: DebugLaunchArgs): Record<string, unknown> {
    // CRITICAL: DAP `launch` libraryUri is the .cql file itself (NOT the
    // parent directory as `executeCql` requires). CqlDebugServer.kt
    // internally derives the directory via Uris.getHead. Single file path
    // from the caller, two shapes computed internally.
    const out: Record<string, unknown> = {
      libraryUri: pathToUri(args.cqlFile),
      libraryName: libraryNameOf(args.cqlFile),
      fhirVersion: args.fhirVersion ?? 'R4',
      stepGranularity: args.stepGranularity ?? 'cql',
    };
    if (args.testCaseName) out.testCaseName = args.testCaseName;
    if (args.testCaseDir) out.testCaseUri = pathToUri(args.testCaseDir);
    if (args.terminologyUri) out.terminologyUri = pathToUri(args.terminologyUri);
    if (args.rootDir) out.rootDir = pathToUri(args.rootDir);
    if (args.optionsPath) out.optionsPath = pathToUri(args.optionsPath);
    if (args.parameters) out.parameters = args.parameters;
    return out;
  }

  /**
   * Common resume-op logic. Sends the DAP request and races the next
   * `stopped` event (followed by `stackTrace` to obtain the topFrame) against
   * `terminated` and a bounded timeout. Timeout is NOT an error: the session
   * stays valid and paused, and the caller may retry the same resume later.
   *
   * Each call captures a generation token (this.resumeGeneration is
   * incremented atomically before any listeners are attached). All settle
   * paths gate on `myGeneration === this.resumeGeneration`, so a late
   * `stopped`/`terminated` event from a prior (timed-out or already-settled)
   * resume cannot be misattributed to a fresh resume's listener — even if
   * cleanup() somehow failed to unregister the prior listener.
   */
  private async resume(
    method: 'continue' | 'next' | 'stepIn' | 'stepOut',
    threadId: number,
    timeoutMs: number | undefined,
  ): Promise<DapStopEvent> {
    this.assertActive();
    const client = this.client!;
    const wait = timeoutMs ?? this.defaultResumeTimeoutMs;
    const myGeneration = ++this.resumeGeneration;
    const isCurrent = (): boolean => myGeneration === this.resumeGeneration;
    let settled = false;

    return new Promise<DapStopEvent>((resolve, reject) => {
      const onStopped = async (msg: DapResponse & { body?: { reason?: string; threadId?: number } }): Promise<void> => {
        if (settled || !isCurrent()) return;
        settled = true;
        cleanup();
        const reason = msg.body?.reason ?? 'breakpoint';
        const tid = msg.body?.threadId ?? threadId;
        try {
          const st = await client.send('stackTrace', { threadId: tid });
          const stackFrames =
            (st.body as { stackFrames?: DapStackFrame[] } | undefined)?.stackFrames ?? [];
          resolve({ event: 'stopped', reason, threadId: tid, topFrame: stackFrames[0] });
        } catch (err) {
          log.warn('DAP stackTrace after stop failed', {
            message: err instanceof Error ? err.message : String(err),
          });
          resolve({ event: 'stopped', reason, threadId: tid });
        }
      };
      const onTerminated = (): void => {
        if (settled || !isCurrent()) return;
        settled = true;
        cleanup();
        resolve({ event: 'terminated' });
      };
      const timer = setTimeout(() => {
        if (settled || !isCurrent()) return;
        settled = true;
        cleanup();
        resolve({ event: 'timeout' });
      }, wait);

      const cleanup = (): void => {
        clearTimeout(timer);
        client.off('stopped', onStopped);
        client.off('terminated', onTerminated);
      };

      client.on('stopped', onStopped);
      client.on('terminated', onTerminated);

      client.send(method, { threadId }).catch((err: Error) => {
        if (settled || !isCurrent()) return;
        settled = true;
        cleanup();
        reject(err);
      });
    });
  }

  private assertActive(): void {
    if (!this.client) {
      throw new Error('debug session not active; call cql_debug_start first');
    }
  }
}
