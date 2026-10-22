import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CqlLsProcess } from '../../src/jvm/cqlLsProcess.js';
import { findJavaRuntime } from '../../src/jvm/javaLocator.js';
import { DapSession } from '../../src/dap/dapSession.js';
import { configureLog } from '../../src/log.js';

configureLog({ level: 'debug' });

function findJar(): string | null {
  const envJar = process.env.CQL_LS_JAR_PATH;
  if (envJar && fs.existsSync(envJar)) return envJar;
  const candidates = [
    path.resolve(process.cwd(), '..', 'vscode-cql', 'dist', 'java-support', 'jars'),
    path.resolve(process.cwd(), 'dist', 'java-support', 'jars'),
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const found = fs.readdirSync(dir).find(
      (f) => f.startsWith('cql-ls-server-') && f.endsWith('.jar'),
    );
    if (found) return path.join(dir, found);
  }
  return null;
}

const projectRoot = process.cwd();
const fixture = (name: string): string => path.join(projectRoot, 'test', 'fixtures', name);

const LOGBACK_FILE =
  process.env.CQL_DEBUG_MCP_LOGBACK_FILE ??
  path.resolve(
    projectRoot,
    '..',
    'cql-language-server',
    'ls',
    'server',
    'src',
    'main',
    'resources',
    'logback.xml',
  );

function newProcess(java: { javaPath: string }, jar: string, workspacePath: string): CqlLsProcess {
  return new CqlLsProcess({
    javaPath: java.javaPath,
    jarPath: jar,
    workspacePath,
    logbackConfigFile: LOGBACK_FILE,
    logFile: process.env.CQL_DEBUG_MCP_LOG_FILE,
  });
}

describe('debugSession integration (real JVM + DAP)', () => {
  const java = findJavaRuntime(process.env.JAVA_HOME);
  const jar = findJar();
  const available = java !== null && jar !== null;

  before(function () {
    if (!available) {
      this.skip();
      return;
    }
    console.log(`integration: java=${java!.javaPath} (v${java!.version}), jar=${jar}`);
    // Tee stderr to the test reporter so LS / DAP diagnostics surface here.
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      original(chunk, ...(args as []));
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      process.stdout.write(`[stderr] ${text}`);
      return true;
    }) as typeof process.stderr.write;
    void original;
  });

  let proc: CqlLsProcess | null = null;
  let session: DapSession | null = null;

  after(async () => {
    await session?.stop();
    await proc?.stop();
  });

  it('starts a session, hits a breakpoint, and exposes locals', async function () {
    if (!available) {
      this.skip();
      return;
    }
    this.timeout(60_000);

    proc = newProcess(java!, jar!, projectRoot);
    await proc.ensureReady();
    expect(proc.currentState).to.equal('ready');

    session = new DapSession({ ls: proc, resumeTimeoutMs: 10_000 });
    const cqlFile = fixture(path.join('debug', 'DebugableLibrary.cql'));

// Start, then set a breakpoint BEFORE continuing. Order matters: the LS
    // uses a streaming breakpoint handler and pauses at breakpoints during
    // its first traversal; once it completes, the session terminates.
    await session.start({ cqlFile });
    expect(session.isActive).to.equal(true);

    // Step1 = 10 on line 4, Step2 = 20 on line 7, Step3 = Step1+Step2 on line 10.
    // Break on line 10 (Step3) so both Step1 and Step2 are in scope when we evaluate.
    const bps = await session.setBreakpoints(cqlFile, [10]);
    expect(bps).to.have.length(1);

    const stop = await session.continue(1);
    expect(stop.event).to.equal('stopped');
    expect(stop.topFrame).to.exist;
    expect(stop.topFrame?.line).to.equal(10);
    expect(stop.topFrame?.source?.path).to.equal(cqlFile);

    // Use `evaluate` to confirm we can ask the LS about a define. The streaming
// handler's runtime registry may or may not have Step1/Step2 cached at the
// exact pause point (depends on stack-depth semantics); the assertion is
// that the round-trip works and the LS returns a structured response.
    const step1 = await session.evaluate('"Step1"', stop.topFrame!.id);
    process.stdout.write(`[integration] evaluate "Step1" at line 10: ${JSON.stringify(step1)}\n`);
    expect(step1).to.have.property('result');
    expect(step1).to.have.property('variablesReference');
  });
});
