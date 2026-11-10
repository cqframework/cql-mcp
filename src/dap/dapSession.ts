import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CqlLsProcess } from '../jvm/cqlLsProcess.js';
import { EXECUTE_CQL, startDebugSession } from '../lsp/lspCommands.js';
import type { ExecuteCqlResponse } from '../lsp/protocol.js';
import { buildExecuteCqlRequest, igDefaultsFor, openCqlFile } from '../tools/executeCqlTool.js';
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
  /** Set when the session terminated without ever stopping; see DapSession.terminatedResult. */
  note?: string;
  /** Breakpoints the LS reported as unverified (for example on a `define` line). */
  unverifiedBreakpoints?: Array<{ line: number; path?: string }>;
  /** Error entries from re-running the launch's request through executeCql. */
  errors?: string[];
  /** Why `errors` could not be collected, if the re-run itself failed. */
  errorsUnavailable?: string;
}

/** Per-session bookkeeping, created on each start() and only updated by that session's client. */
interface SessionState {
  launch: DebugLaunchArgs;
  everStopped: boolean;
  /** Latest known breakpoints, keyed by LS id (or path:line when the LS sent no id). */
  breakpoints: Map<string, { line: number; path?: string; verified: boolean }>;
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
  /** Retry interval and bound while the LS refuses a start because the previous session is closing. */
  startRetryIntervalMs?: number;
  startRetryTimeoutMs?: number;
  /** How long stop() waits for the LS to close the socket after disconnect. */
  stopSocketWaitMs?: number;
}

const DEFAULT_RESUME_TIMEOUT_MS = 30_000;
const DEFAULT_START_RETRY_INTERVAL_MS = 100;
const DEFAULT_START_RETRY_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_SOCKET_WAIT_MS = 1_000;

/**
 * The LS refuses startDebugSession while its previous session is still shutting down
 * (cql-language-server DebugCommandContribution.kt:42-44): that session stays active until
 * `exited()` plus a 250 ms socket-close grace (DebugSession.kt:27, :105). The refusal reaches the
 * client as a generic JSON-RPC internal error; only the stack trace in `data` names the cause.
 */
const SESSION_BUSY_CODE = -32603;
const SESSION_BUSY_TEXT = 'wait for the current debug session to end';

/** True for the LS's "previous debug session is still shutting down" refusal, and nothing else. */
export function isPreviousSessionBusy(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { code, data } = err as { code?: unknown; data?: unknown };
  if (code !== SESSION_BUSY_CODE) return false;
  const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
  return text.includes(SESSION_BUSY_TEXT);
}

export class DapSession {
  protected readonly ls: CqlLsProcess;
  protected readonly dapClientFactory: () => DapClient;
  protected defaultResumeTimeoutMs: number;
  protected readonly startRetryIntervalMs: number;
  protected readonly startRetryTimeoutMs: number;
  protected readonly stopSocketWaitMs: number;
  protected client: DapClient | null = null;
  protected state: SessionState | null = null;
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
    this.startRetryIntervalMs = opts.startRetryIntervalMs ?? DEFAULT_START_RETRY_INTERVAL_MS;
    this.startRetryTimeoutMs = opts.startRetryTimeoutMs ?? DEFAULT_START_RETRY_TIMEOUT_MS;
    this.stopSocketWaitMs = opts.stopSocketWaitMs ?? DEFAULT_STOP_SOCKET_WAIT_MS;
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

    const port = await this.requestDebugPort();
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
      throw new Error(`startDebugSession returned invalid port: ${JSON.stringify(port)}`);
    }
    log.info('DAP dial', { port });

    const client = this.dapClientFactory();
    const state: SessionState = { launch: args, everStopped: false, breakpoints: new Map() };
    this.state = state;
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

    this.trackState(client, state);
    try {
      await client.send('initialize', {
        clientID: 'cql-mcp',
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
        await this.sendSetBreakpoints(client, state, args.cqlFile, args.breakpoints);
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
    return this.sendSetBreakpoints(this.client!, this.state!, cqlFile, lines);
  }

  private async sendSetBreakpoints(
    client: DapClient,
    state: SessionState,
    cqlFile: string,
    lines: number[],
  ): Promise<Array<{ verified: boolean; line: number; source?: { name?: string; path?: string } }>> {
    const res = await client.send('setBreakpoints', {
      source: { name: libraryNameOf(cqlFile), path: cqlFile },
      breakpoints: lines.map((line) => ({ line })),
    });
    const body = res.body as { breakpoints?: Array<{ id?: number; verified: boolean; line: number }> } | undefined;
    const breakpoints = body?.breakpoints ?? [];
    // setBreakpoints replaces every breakpoint for this source.
    for (const [key, bp] of state.breakpoints) {
      if (bp.path === cqlFile) state.breakpoints.delete(key);
    }
    for (const bp of breakpoints) {
      state.breakpoints.set(bp.id !== undefined ? String(bp.id) : `${cqlFile}:${bp.line}`, {
        line: bp.line,
        path: cqlFile,
        verified: bp.verified,
      });
    }
    return breakpoints;
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
    // The LS closes the socket once its session has ended; waiting for that (bounded) makes an
    // immediate cql_debug_start much less likely to be refused. requestDebugPort retries if it is.
    await this.waitForSocketEnd(client, this.stopSocketWaitMs);
    await client.dispose();
    log.info('DAP session stopped');
  }

  private waitForSocketEnd(client: DapClient, ms: number): Promise<void> {
    if (!client.isConnected()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        client.off('end', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      client.once('end', done);
    });
  }

  /** startDebugSession, retried while the LS's previous session is still shutting down. */
  private async requestDebugPort(): Promise<number> {
    const deadline = Date.now() + this.startRetryTimeoutMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return await startDebugSession(this.ls.lspClient);
      } catch (err) {
        if (!isPreviousSessionBusy(err)) throw err;
        if (Date.now() >= deadline) {
          throw new Error(
            `previous debug session still shutting down after ${this.startRetryTimeoutMs / 1000} s; ` +
              'try cql_debug_start again',
          );
        }
        log.debug('startDebugSession refused: previous session still shutting down; retrying', { attempt });
        await new Promise((r) => setTimeout(r, this.startRetryIntervalMs));
      }
    }
  }

  /**
   * Keeps `state` current from this client's events: whether the debuggee ever stopped, and the
   * LS's later verdicts on breakpoints. The LS first answers setBreakpoints with verified=true, then
   * sends a `breakpoint` event (reason "changed", verified=false) for lines it cannot stop on, such
   * as a `define` line (BreakpointManager.updateBreakpointLineVerification). State belongs to one
   * session, so events from an earlier session's client cannot reach a new one.
   */
  private trackState(client: DapClient, state: SessionState): void {
    client.on('stopped', () => {
      state.everStopped = true;
    });
    client.on('breakpoint', (msg: { body?: { breakpoint?: { id?: number; verified?: boolean; line?: number; source?: { path?: string } } } }) => {
      const bp = msg.body?.breakpoint;
      if (!bp || bp.id === undefined) return;
      const key = String(bp.id);
      const prev = state.breakpoints.get(key);
      const line = bp.line ?? prev?.line;
      if (line === undefined) return;
      state.breakpoints.set(key, {
        line,
        path: bp.source?.path ?? prev?.path,
        verified: bp.verified ?? prev?.verified ?? true,
      });
    });
  }

  /**
   * The result of a resume that ended in `terminated`. A run to the end after a stop, or with no
   * breakpoints, is ordinary. Breakpoints that were never hit usually mean the library did not
   * compile or evaluate (the debug launch reports nothing in that case), or that a breakpoint sat
   * on a line the LS cannot stop on; so the unverified breakpoints are listed, and the launch's
   * request is re-run through executeCql to collect its Error entries.
   */
  private async terminatedResult(state: SessionState): Promise<DapStopEvent> {
    if (state.everStopped) {
      return { event: 'terminated' };
    }
    if (state.breakpoints.size === 0) {
      return { event: 'terminated', note: 'terminated (no breakpoints set)' };
    }
    const result: DapStopEvent = {
      event: 'terminated',
      note:
        'terminated without stopping: no breakpoint was hit. Check unverifiedBreakpoints (put breakpoints ' +
        'on an expression line, not the `define` line) and errors (from re-running the library).',
      unverifiedBreakpoints: [...state.breakpoints.values()]
        .filter((bp) => !bp.verified)
        .map((bp) => ({ line: bp.line, path: bp.path })),
    };
    try {
      result.errors = await this.launchErrors(state.launch);
    } catch (err) {
      result.errorsUnavailable = err instanceof Error ? err.message : String(err);
    }
    return result;
  }

  /** Error entries from evaluating the launch's request (same LS evaluator, same request shape). */
  private async launchErrors(launch: DebugLaunchArgs): Promise<string[]> {
    const cqlFile = path.resolve(launch.cqlFile);
    await this.ls.ensureReady();
    openCqlFile(this.ls.lspClient, cqlFile);
    const request = buildExecuteCqlRequest({
      cqlFile,
      fhirVersion: launch.fhirVersion,
      contextValues: launch.testCaseName ? [launch.testCaseName] : undefined,
      modelUri: launch.testCaseDir,
      rootDir: launch.rootDir,
      terminologyUri: launch.terminologyUri,
      optionsPath: launch.optionsPath,
    });
    const response = (await this.ls.executeCommand(EXECUTE_CQL, [request])) as ExecuteCqlResponse;
    return response.results.flatMap((r) => r.expressions.filter((e) => e.name === 'Error').map((e) => e.value));
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
    //
    // rootDir, terminologyUri and optionsPath default from the file's IG, as for executeCql
    // (igDefaultsFor); without rootDir an IG library fails to compile and the session just
    // terminates. The default-layout paths are only sent when they exist.
    const ig = igDefaultsFor(path.resolve(args.cqlFile));
    const existing = (p: string | undefined): string | undefined => (p && fs.existsSync(p) ? p : undefined);
    const rootDir = args.rootDir ?? ig.rootDir;
    const terminologyUri = args.terminologyUri ?? existing(ig.terminologyUri);
    const optionsPath = args.optionsPath ?? existing(ig.optionsPath);
    const out: Record<string, unknown> = {
      libraryUri: pathToUri(args.cqlFile),
      libraryName: libraryNameOf(args.cqlFile),
      fhirVersion: args.fhirVersion ?? 'R4',
      stepGranularity: args.stepGranularity ?? 'cql',
    };
    if (args.testCaseName) out.testCaseName = args.testCaseName;
    if (args.testCaseDir) out.testCaseUri = pathToUri(args.testCaseDir);
    if (terminologyUri) out.terminologyUri = pathToUri(terminologyUri);
    if (rootDir) out.rootDir = pathToUri(rootDir);
    if (optionsPath) out.optionsPath = pathToUri(optionsPath);
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
    const state = this.state;
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
      const onTerminated = async (): Promise<void> => {
        if (settled || !isCurrent()) return;
        settled = true;
        cleanup();
        resolve(state ? await this.terminatedResult(state) : { event: 'terminated' });
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
