import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CqlLsProcess } from '../../src/jvm/cqlLsProcess.js';
import { findJavaRuntime } from '../../src/jvm/javaLocator.js';
import { DapSession } from '../../src/dap/dapSession.js';
import type { McpContext } from '../../src/tools/defs.js';
import { buildExecuteCqlRequest, executeCqlTool, type CqlExecuteResult } from '../../src/tools/executeCqlTool.js';
import { runSuite } from '../../src/testPipeline/suiteRunner.js';
import { pathToUri } from '../../src/workspace/paths.js';

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
const LOGBACK_FILE =
  process.env.CQL_MCP_LOGBACK_FILE ??
  path.resolve(projectRoot, '..', 'cql-language-server', 'ls', 'server', 'src', 'main', 'resources', 'logback.xml');

// A minimal IG in the IG Publisher default layout (path-binary = input/cql): ig.ini plus an
// ImplementationGuide, input/cql/IgMinimal.cql, and two test cases under input/tests/IgMinimal/.
// p1 has a Condition, p2 does not, so "Has Condition" is only true for p1 when each case's folder
// is sent as the data model.
const igRoot = path.join(projectRoot, 'test', 'fixtures', 'ig-minimal');
const igCql = path.join(igRoot, 'input', 'cql', 'IgMinimal.cql');

function values(result: { expressions: Array<{ name: string; value: string }> }): Map<string, string> {
  return new Map(result.expressions.map((e) => [e.name, e.value]));
}

describe('IG layout integration (real JVM)', () => {
  const java = findJavaRuntime(process.env.JAVA_HOME);
  const jar = findJar();
  const available = java !== null && jar !== null;

  let proc: CqlLsProcess | null = null;
  let ctx: McpContext | null = null;
  let runStore: string;

  before(async function () {
    if (!available) {
      this.skip();
      return;
    }
    console.log(`integration: java=${java!.javaPath} (v${java!.version}), jar=${jar}`);
    runStore = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-layout-runs-'));
    proc = new CqlLsProcess({
      javaPath: java!.javaPath,
      jarPath: jar!,
      workspacePath: projectRoot,
      logbackConfigFile: LOGBACK_FILE,
    });
    ctx = {
      process: proc,
      debugSession: {} as DapSession,
      jarPath: jar!,
      javaVersion: java!.version,
      workspaceRoot: runStore,
    };
    await proc.ensureReady();
  });

  after(async () => {
    await proc?.stop();
    if (runStore) {
      fs.rmSync(runStore, { recursive: true, force: true });
    }
  });

  it("cql_test_run_suite evaluates each case against its own folder's data", async function () {
    if (!available) return this.skip();
    const run = await runSuite(
      { process: proc!, workspaceRoot: runStore },
      { cqlFile: igCql, suiteRoot: path.join(igRoot, 'input', 'tests'), suiteName: 'IgMinimal' },
    );
    const byPatient = new Map(run.cases.map((c) => [c.patientId, c]));
    expect([...byPatient.keys()].sort()).to.deep.equal(['p1', 'p2']);
    expect(byPatient.get('p1')!.errors).to.deep.equal([]);
    expect(byPatient.get('p2')!.errors).to.deep.equal([]);
    expect(values(byPatient.get('p1')!).get('Has Condition')).to.equal('true');
    expect(values(byPatient.get('p2')!).get('Has Condition')).to.equal('false');
  });

  it('cql_execute derives rootDir for an IG-layout file and evaluates', async function () {
    if (!available) return this.skip();
    expect(buildExecuteCqlRequest({ cqlFile: igCql }).rootDir).to.equal(pathToUri(igRoot));
    const result = (await executeCqlTool.handler(ctx!, {
      cqlFile: igCql,
      contextValues: ['p1'],
      modelUri: path.join(igRoot, 'input', 'tests', 'IgMinimal', 'p1'),
    })) as CqlExecuteResult;
    expect(result.diagnostics).to.deep.equal([]);
    expect(values(result.results[0]!).get('Has Condition')).to.equal('true');
  });

  it('cql_execute sends no rootDir for a file outside an IG and still evaluates', async function () {
    if (!available) return this.skip();
    const scratch = path.join(projectRoot, 'test', 'fixtures', 'basic', 'BasicLibrary.cql');
    expect(buildExecuteCqlRequest({ cqlFile: scratch }).rootDir).to.equal(null);
    const result = (await executeCqlTool.handler(ctx!, { cqlFile: scratch })) as CqlExecuteResult;
    expect(result.success).to.equal(true);
    expect(values(result.results[0]!).get('One')).to.equal('1');
  });

  it('cql_debug_start on an IG-layout file stops at a breakpoint', async function () {
    if (!available) return this.skip();
    this.timeout(60_000);
    const session = new DapSession({ ls: proc!, resumeTimeoutMs: 30_000 });
    try {
      await session.start({
        cqlFile: igCql,
        testCaseName: 'p1',
        testCaseDir: path.join(igRoot, 'input', 'tests', 'IgMinimal', 'p1'),
      });
      await session.setBreakpoints(igCql, [8]); // `exists [Condition]`, the body of "Has Condition"
      const ev = await session.continue(1);
      expect(ev.event).to.equal('stopped');
      expect(ev.topFrame?.line).to.equal(8);
    } finally {
      await session.stop();
    }
  });

  it('a debug session that terminates without stopping reports the library errors', async function () {
    if (!available) return this.skip();
    this.timeout(60_000);
    // On a library with compile errors the LS launch succeeds, sends no output, and terminates.
    const broken = path.join(projectRoot, 'test', 'fixtures', 'malformed', 'BrokenLibrary.cql');
    const session = new DapSession({ ls: proc!, resumeTimeoutMs: 30_000 });
    try {
      await session.start({ cqlFile: broken });
      await session.setBreakpoints(broken, [4]);
      const ev = await session.continue(1);
      expect(ev.event).to.equal('terminated');
      expect(ev.note).to.contain('terminated without stopping');
      expect(ev.errors).to.be.an('array').that.is.not.empty;
      expect(session.isActive).to.equal(false);
    } finally {
      await session.stop();
    }
  });
});
