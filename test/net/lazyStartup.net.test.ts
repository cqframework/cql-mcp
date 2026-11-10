import { expect } from 'chai';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FakeMavenRepo } from '../helpers/fakeMavenRepo.js';

const entry = path.resolve(__dirname, '..', '..', 'src', 'index.js');

/** Minimal newline-delimited JSON-RPC client over the MCP server's stdio. */
class StdioClient {
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (msg: any) => void>();

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) this.pending.get(msg.id)?.(msg);
      }
    });
  }

  request(method: string, params: unknown, timeoutMs = 10_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }

  async status(): Promise<any> {
    const res = await this.request('tools/call', { name: 'cql_get_status', arguments: {} });
    return JSON.parse(res.result.content[0].text);
  }
}

/** A `java` that only answers `-version`, so layer 2 needs no JDK. POSIX only. */
function writeFakeJavaHome(dir: string): string | null {
  if (process.platform === 'win32') return null;
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'java'), '#!/bin/sh\necho \'openjdk version "17.0.1" 2021-10-19\' >&2\n', { mode: 0o755 });
  return dir;
}

describe('net: lazy startup (ADR-0001 §2.2)', function () {
  let repo: FakeMavenRepo;
  let tmp: string;

  before(async () => {
    repo = await FakeMavenRepo.start();
    // The jar download starts and then stalls: 512 bytes of a 10 MB body.
    repo.route(/\.jar$/, { kind: 'stall-after', bytes: 512 });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cql-mcp-net-'));
  });

  after(async () => {
    await repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('answers initialize in under 1 s with an empty cache, then reports the stalled download and exits cleanly', async function () {
    const javaHome = writeFakeJavaHome(path.join(tmp, 'fakejdk'));
    if (!javaHome && !process.env.JAVA_HOME) {
      this.skip(); // Windows without a JDK: nothing to stand in for java.exe
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CQL_MCP_JAR_DIR: path.join(tmp, 'jars'),
      CQL_MCP_WORKSPACE: tmp,
      CQL_LS_MAVEN_REPO: repo.url,
      CQL_LS_VERSION: '9.9.9',
    };
    delete env.CQL_LS_JAR_PATH;
    if (javaHome) env.JAVA_HOME = javaHome;

    const spawnedAt = Date.now();
    const child = spawn(process.execPath, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const client = new StdioClient(child);

    try {
      const init = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'net-test', version: '0' },
      });
      const latencyMs = Date.now() - spawnedAt;
      console.log(`net: initialize answered ${latencyMs} ms after spawn (process start included)`);
      expect(init.result.serverInfo.name).to.equal('cql-mcp');
      expect(latencyMs, 'initialize latency').to.be.lessThan(1000);
      client.notify('notifications/initialized');

      const tools = await client.request('tools/list', {});
      expect(tools.result.tools.length).to.be.greaterThan(0);

      // The first status call starts resolution; poll until the stalled download shows up.
      let status = await client.status();
      expect(status.runtime.state).to.equal('resolving');
      const deadline = Date.now() + 8000;
      while (!(status.runtime.phase === 'jar' && status.runtime.download) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        status = await client.status();
      }
      console.log(`net: cql_get_status during resolving: ${JSON.stringify(status)}`);
      expect(status.runtime.state).to.equal('resolving');
      expect(status.runtime.phase).to.equal('jar');
      expect(status.runtime.download.url).to.include(repo.url).and.to.include('cql-ls-server-9.9.9.jar');
      expect(status.runtime.download.bytes).to.be.greaterThan(0);
      expect(status.ready).to.equal(false);
      expect(repo.jarRequests.length).to.be.greaterThan(0);
    } finally {
      child.stdin.end(); // MCP clients disconnect by closing stdin
    }

    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20_000)),
    ]);
    if (code === 'timeout') child.kill('SIGKILL');
    expect(code, 'exit code after stdin close').to.equal(0);
  });
});
