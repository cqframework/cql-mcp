import { expect } from 'chai';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findJavaRuntime } from '../../src/jvm/javaLocator.js';

function findJar(): string | null {
  const envJar = process.env.CQL_LS_JAR_PATH;
  if (envJar && fs.existsSync(envJar)) {
    return envJar;
  }
  const candidates = [
    path.resolve(process.cwd(), '..', 'vscode-cql', 'dist', 'java-support', 'jars'),
    path.resolve(process.cwd(), 'dist', 'java-support', 'jars'),
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    const found = fs.readdirSync(dir).find((f) => f.startsWith('cql-ls-server-') && f.endsWith('.jar'));
    if (found) {
      return path.join(dir, found);
    }
  }
  return null;
}

const projectRoot = process.cwd();
const entry = path.join(projectRoot, 'dist', 'src', 'index.js');

/** The MCP server as a client sees it: NDJSON JSON-RPC over the child's stdin/stdout. */
class McpChild {
  readonly child: ChildProcess;
  private buffer = '';
  private readonly responses = new Map<number, { result?: { content?: Array<{ text?: string }> } }>();
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(jar: string, workspace: string) {
    this.child = spawn(process.execPath, [entry], {
      env: { ...process.env, CQL_LS_JAR_PATH: jar, CQL_DEBUG_MCP_WORKSPACE: workspace },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exit = new Promise((resolve) => this.child.once('exit', (code, signal) => resolve({ code, signal })));
    this.child.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      for (let i = this.buffer.indexOf('\n'); i >= 0; i = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        try {
          const msg = JSON.parse(line) as { id?: number };
          if (typeof msg.id === 'number') this.responses.set(msg.id, msg as never);
        } catch {
          /* not a JSON-RPC line */
        }
      }
    });
  }

  send(msg: object): void {
    this.child.stdin!.write(`${JSON.stringify(msg)}\n`);
  }

  async request(id: number, method: string, params: object, timeoutMs: number) {
    this.send({ jsonrpc: '2.0', id, method, params });
    const deadline = Date.now() + timeoutMs;
    while (!this.responses.has(id)) {
      if (Date.now() > deadline) throw new Error(`no response to ${method} within ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.responses.get(id)!;
  }

  async initialize(): Promise<void> {
    await this.request(
      1,
      'initialize',
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdin-close-test', version: '0' } },
      15_000,
    );
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms)),
  ]);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// MCP clients disconnect by closing the server's stdin. The SDK's stdio transport does not report
// that, so the server must notice it itself and stop the LS JVM it started.
describe('stdin close integration (real node + JVM)', () => {
  const java = findJavaRuntime(process.env.JAVA_HOME);
  const jar = findJar();
  // pgrep is used to find the JVM child; it is not available on Windows.
  const available = java !== null && jar !== null && process.platform !== 'win32';

  let workspace: string;
  let mcp: McpChild | null = null;
  let jvmPid: number | null = null;

  beforeEach(function () {
    if (!available) {
      this.skip();
      return;
    }
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'stdin-close-'));
  });

  afterEach(() => {
    // Never leave processes behind, even when an assertion failed.
    if (mcp && mcp.child.exitCode === null && mcp.child.signalCode === null) mcp.child.kill('SIGKILL');
    if (jvmPid !== null && alive(jvmPid)) process.kill(jvmPid, 'SIGKILL');
    mcp = null;
    jvmPid = null;
    if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('exits when stdin closes before any JVM was started', async function () {
    this.timeout(30_000);
    mcp = new McpChild(jar!, workspace);
    await mcp.initialize();
    mcp.child.stdin!.end();
    const exit = await within(mcp.exit, 5_000, 'server exit');
    expect(exit).to.deep.equal({ code: 0, signal: null });
  });

  it('exits and stops its JVM when stdin closes', async function () {
    this.timeout(120_000);
    mcp = new McpChild(jar!, workspace);
    await mcp.initialize();
    const status = await mcp.request(2, 'tools/call', { name: 'cql_get_status', arguments: {} }, 90_000);
    expect(JSON.parse(status.result?.content?.[0]?.text ?? '{}').ready).to.equal(true);
    const children = execFileSync('pgrep', ['-P', String(mcp.child.pid)], { encoding: 'utf8' }).trim().split('\n');
    expect(children).to.have.length(1);
    jvmPid = Number(children[0]);
    expect(alive(jvmPid)).to.equal(true);

    mcp.child.stdin!.end();
    const exit = await within(mcp.exit, 20_000, 'server exit');
    expect(exit).to.deep.equal({ code: 0, signal: null });
    const deadline = Date.now() + 10_000;
    while (alive(jvmPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(alive(jvmPid)).to.equal(false);
  });
});
