import { log } from '../log.js';
import { ensureJar, JarInstallError } from './jarInstaller.js';
import type { JarInstallOptions, JarResolution } from './jarInstaller.js';
import { findJavaRuntime, REQUIRED_JDK_VERSION } from './javaLocator.js';
import type { JavaRuntime } from './javaLocator.js';

export interface ResolvedRuntime {
  javaPath: string;
  javaVersion: number;
  jarPath: string;
  jarSource: JarResolution['source'];
  lsVersion: string | null;
}

export type RuntimeState = 'idle' | 'resolving' | 'ready' | 'failed';

export interface RuntimeStatus {
  state: RuntimeState;
  phase?: 'java' | 'jar';
  jarSource?: JarResolution['source'];
  jarPath?: string;
  lsVersion?: string | null;
  javaVersion?: number;
  download?: { url: string; bytes: number; totalBytes?: number };
  error?: string;
}

export interface RuntimeResolverDeps {
  findJava?: () => JavaRuntime | null;
  resolveJar?: (options?: JarInstallOptions) => Promise<JarResolution>;
}

/** Removes any userinfo (user:password@) from a URL so it is safe to report. */
function stripUserinfo(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url.replace(/\/\/[^/@]*@/, '//');
  }
}

function lsVersionOf(jarPath: string): string | null {
  const m = /cql-ls-server-(.+)\.jar$/.exec(jarPath.split(/[\\/]/).pop() ?? '');
  return m ? m[1] : null;
}

/**
 * Resolves the Java runtime and the language-server jar lazily and memoized, so the MCP server can
 * answer `initialize` before either is available (ADR-0001 §2.2). A failure is not cached: the
 * next resolve() retries, so network or configuration problems can be fixed without a restart.
 */
export class RuntimeResolver {
  private readonly findJava: () => JavaRuntime | null;
  private readonly resolveJar: (options?: JarInstallOptions) => Promise<JarResolution>;

  private inflight: Promise<ResolvedRuntime> | null = null;
  private result: ResolvedRuntime | null = null;
  private state: RuntimeState = 'idle';
  private phase: 'java' | 'jar' | undefined;
  private download: RuntimeStatus['download'];
  private error: string | undefined;

  constructor(deps: RuntimeResolverDeps = {}) {
    this.findJava = deps.findJava ?? (() => findJavaRuntime());
    this.resolveJar = deps.resolveJar ?? ensureJar;
  }

  resolve(): Promise<ResolvedRuntime> {
    if (this.result) {
      return Promise.resolve(this.result);
    }
    if (!this.inflight) {
      this.state = 'resolving';
      this.phase = 'java';
      this.error = undefined;
      this.download = undefined;
      this.inflight = this.doResolve().then(
        (r) => {
          this.result = r;
          this.state = 'ready';
          this.phase = undefined;
          this.download = undefined;
          this.inflight = null;
          log.info(`Using cql-language-server jar: ${r.jarPath} (source=${r.jarSource})`);
          return r;
        },
        (err: unknown) => {
          this.state = 'failed';
          this.phase = undefined;
          this.download = undefined;
          this.error = err instanceof Error ? err.message : String(err);
          this.inflight = null;
          throw err;
        },
      );
    }
    return this.inflight;
  }

  /** Fire-and-forget resolve() that never causes an unhandled rejection. */
  start(): void {
    this.resolve().catch((err: unknown) => {
      log.warn('Runtime resolution failed', { message: err instanceof Error ? err.message : String(err) });
    });
  }

  status(): RuntimeStatus {
    const s: RuntimeStatus = { state: this.state };
    if (this.phase) s.phase = this.phase;
    if (this.result) {
      s.jarSource = this.result.jarSource;
      s.jarPath = this.result.jarPath;
      s.lsVersion = this.result.lsVersion;
      s.javaVersion = this.result.javaVersion;
    }
    if (this.download) s.download = this.download;
    if (this.error) s.error = this.error;
    return s;
  }

  private async doResolve(): Promise<ResolvedRuntime> {
    // Yield first so a start() caller returns before the (synchronous) Java probe runs.
    await new Promise<void>((resolve) => setImmediate(resolve));

    let java: JavaRuntime | null = null;
    try {
      java = this.findJava();
    } catch (err) {
      log.warn('Java detection errored', { message: err instanceof Error ? err.message : String(err) });
    }
    if (!java) {
      throw new Error(
        `No Java >= ${REQUIRED_JDK_VERSION} found. Set JAVA_HOME or add java to PATH. Detected candidates: ${[
          process.env.JAVA_HOME ? process.env.JAVA_HOME + '/bin/java' : '',
          'java (PATH)',
        ]
          .filter(Boolean)
          .join(', ')}`,
      );
    }

    this.phase = 'jar';
    let jar: JarResolution;
    try {
      jar = await this.resolveJar({
        onProgress: (p) => {
          this.download = { url: stripUserinfo(p.url), bytes: p.bytes, totalBytes: p.totalBytes };
        },
      });
    } catch (err) {
      if (err instanceof JarInstallError) {
        throw new Error(
          `Failed to obtain the cql-language-server jar: ${err.message}. ` +
            `Set CQL_LS_JAR_PATH to a local jar to bypass download.`,
        );
      }
      throw err;
    }
    return {
      javaPath: java.javaPath,
      javaVersion: java.version,
      jarPath: jar.jarPath,
      jarSource: jar.source,
      lsVersion: lsVersionOf(jar.jarPath),
    };
  }
}
