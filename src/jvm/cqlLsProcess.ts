import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import type { WorkspaceFolder } from 'vscode-languageserver-protocol';
import { log, tailOf } from '../log.js';
import { LspClient } from '../lsp/lspClient.js';
import { pathToUri } from '../workspace/paths.js';
import { registerWorkspaceFolder } from '../lsp/documentSync.js';

export type ProcessState = 'idle' | 'starting' | 'ready' | 'crashed' | 'stopping' | 'stopped';

export interface CrashInfo {
  exitCode: number | null;
  signal: string | null;
  stderrTail: string[];
}

export class LanguageServerCrashedError extends Error {
  readonly kind = 'language_server_crashed' as const;

  constructor(readonly crash: CrashInfo) {
    super('language_server_crashed');
    this.name = 'LanguageServerCrashedError';
  }
}

export interface CqlLsProcessOptions {
  javaPath: string;
  jarPath: string;
  workspacePath: string;
  logFile?: string;
  /** External logback.xml to force via -Dlogback.configurationFile. Guarantees
   *  the LSP stdout channel stays clean even if the jar bundles a broken config. */
  logbackConfigFile?: string;
  spawnImpl?: typeof spawn;
  initializeTimeoutMs?: number;
  respawnLimit?: number;
  stderrTailMax?: number;
}

const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_RESPAWN_LIMIT = 3;
const DEFAULT_STDERR_TAIL = 200;

export class CqlLsProcess {
  private readonly initializeTimeoutMs: number;
  private readonly respawnLimit: number;
  private readonly stderrTailMax: number;

  private child: ChildProcess | null = null;
  private lsp: LspClient | null = null;
  private state: ProcessState = 'idle';
  private crash: CrashInfo | null = null;
  private stderrTail: string[] = [];
  private lifecycleCount = 0;
  private readyPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly opts: CqlLsProcessOptions) {
    this.initializeTimeoutMs = opts.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.respawnLimit = opts.respawnLimit ?? DEFAULT_RESPAWN_LIMIT;
    this.stderrTailMax = opts.stderrTailMax ?? DEFAULT_STDERR_TAIL;
  }

  get currentState(): ProcessState {
    return this.state;
  }

  get crashInfo(): CrashInfo | null {
    return this.crash;
  }

  get lspClient(): LspClient {
    const client = this.lsp;
    if (!client) {
      throw new Error('CQL language server is not running');
    }
    return client;
  }

  /** @internal exposed for integration tests */
  get debugChild(): ChildProcess | null {
    return this.child;
  }

  async ensureReady(): Promise<void> {
    if (this.state === 'ready') {
      return;
    }
    if (this.state === 'stopping' || this.state === 'stopped') {
      throw new Error('CQL language server has been shut down');
    }
    if (this.state === 'starting') {
      await this.readyPromise;
      return;
    }
    await this.spawnAndInitialize();
  }

  async executeCommand(command: string, args: unknown[]): Promise<unknown> {
    await this.ensureReady();
    const client = this.lsp;
    if (!client) {
      throw this.crash ? new LanguageServerCrashedError(this.crash) : new Error('CQL language server is not running');
    }
    try {
      return await client.sendExecuteCommand(command, args);
    } catch (err) {
      if (this.state === 'crashed' && this.crash) {
        throw new LanguageServerCrashedError(this.crash);
      }
      if (!this.child && this.crash) {
        throw new LanguageServerCrashedError(this.crash);
      }
      throw err;
    }
  }

  private async spawnAndInitialize(): Promise<void> {
    if (this.lifecycleCount >= this.respawnLimit) {
      throw new Error(
        `CQL language server crashed ${this.lifecycleCount} times and has hit the respawn limit (${this.respawnLimit})`,
      );
    }

    const spawnImpl = this.opts.spawnImpl ?? spawn;
    this.lifecycleCount += 1;
    this.stopping = false;
    this.state = 'starting';
    this.crash = null;
    this.stderrTail = [];

    const args = this.buildArgs();
    const child = spawnImpl(this.opts.javaPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child = child;

    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        this.stderrTail = tailOf(
          [...this.stderrTail, ...text.split('\n')],
          this.stderrTailMax,
        );
        log.debug(`[cql-ls stderr] ${text.replace(/\n$/, '')}`);
      });
    }

    const reader = new StreamMessageReader(child.stdout!);
    const writer = new StreamMessageWriter(child.stdin!);
    const { client, connection } = LspClient.create(reader, writer);
    this.lsp = client;

    // Each spawn registers its own onClose / once('exit') listeners that
    // capture `this` via closure. If a previous lifecycle's child dies
    // AFTER the next respawn has reset `stopping=false` and `state=ready`,
    // those stale listeners would fire and call handleGone on the NEW
    // lifecycle, disposing the active LSP client. Guard with the lifecycle
    // generation: only handle events from the CURRENT child.
    const myGeneration = this.lifecycleCount;

    connection.onClose(() => {
      if (this.lifecycleCount !== myGeneration || this.stopping) {
        return;
      }
      this.handleGone('connection closed');
    });

    child.once('exit', (code, signal) => {
      if (this.lifecycleCount !== myGeneration || this.stopping) {
        return;
      }
      this.handleGone('process exited', code, signal);
    });

    this.readyPromise = (async () => {
      await this.runInitialize(client);
    })();

    try {
      await this.readyPromise;
      this.state = 'ready';
      log.info(`CQL language server ready (pid=${child.pid})`);
    } catch (err) {
      this.readyPromise = null;
      if (this.child === child) {
        this.teardownUnexpected(child, err);
      }
      throw err;
    }
  }

  private async runInitialize(client: LspClient): Promise<void> {
    const folder: WorkspaceFolder = {
      uri: pathToUri(this.opts.workspacePath),
      name: path.basename(this.opts.workspacePath) || 'workspace',
    };
    const initializePromise: Promise<void> = (async () => {
      await client.initialize([folder]);
      registerWorkspaceFolder(client, this.opts.workspacePath);
    })();

    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`CQL language server did not answer initialize within ${this.initializeTimeoutMs}ms`));
      }, this.initializeTimeoutMs);
      timer.unref?.();
    });

    try {
      await Promise.race([initializePromise, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private handleGone(reason: string, exitCode?: number | null, signal?: string | null): void {
    if (this.stopping || this.state === 'stopped') {
      return;
    }
    const crash: CrashInfo = {
      exitCode: exitCode ?? this.child?.exitCode ?? null,
      signal: signal ?? this.child?.signalCode ?? null,
      stderrTail: [...this.stderrTail],
    };
    this.crash = crash;
    this.state = 'crashed';
    this.lsp?.dispose();
    this.lsp = null;
    this.child = null;
    this.readyPromise = null;
    log.warn(`CQL language server went away (${reason})`, {
      exitCode: crash.exitCode,
      signal: crash.signal,
    });
  }

  private teardownUnexpected(child: ChildProcess, cause: unknown): void {
    this.stopping = true;
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    const crash: CrashInfo = {
      exitCode: child.exitCode ?? null,
      signal: child.signalCode ?? null,
      stderrTail: [...this.stderrTail],
    };
    this.crash = crash;
    this.state = 'crashed';
    this.lsp?.dispose();
    this.lsp = null;
    this.child = null;
    log.warn('CQL language server failed to become ready', {
      cause: cause instanceof Error ? cause.message : String(cause),
      exitCode: crash.exitCode,
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    const client = this.lsp;
    if (!child || this.state === 'stopped') {
      this.state = 'stopped';
      return;
    }
    this.stopping = true;
    this.state = 'stopping';
    log.info('Shutting down CQL language server');

    if (client) {
      try {
        await client.sendRequest('shutdown');
      } catch {
        // server may already be down
      }
      try {
        client.sendNotification('exit');
      } catch {
        // ignore
      }
    }

    if (!(await this.waitExit(child, 5000))) {
      log.warn('CQL language server did not exit after shutdown; sending SIGTERM');
      child.kill('SIGTERM');
      if (!(await this.waitExit(child, 3000))) {
        log.warn('CQL language server ignored SIGTERM; sending SIGKILL');
        child.kill('SIGKILL');
      }
    }

    client?.dispose();
    this.child = null;
    this.lsp = null;
    this.state = 'stopped';
    log.info('CQL language server stopped');
  }

  private waitExit(child: ChildProcess, ms: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private buildArgs(): string[] {
    const args: string[] = ['-Xmx4g'];
    if (this.opts.logFile) {
      args.push(`-DLOG_FILE=${this.opts.logFile}`);
    }
    if (this.opts.logbackConfigFile) {
      args.push(`-Dlogback.configurationFile=${this.opts.logbackConfigFile}`);
    }
    args.push('-jar', this.opts.jarPath);
    // The LS carries a TODO for full -workspace support; pass it anyway for
    // forward-compat and do not assume it drives file resolution.
    args.push('-workspace', this.opts.workspacePath);
    return args;
  }
}