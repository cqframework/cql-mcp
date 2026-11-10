import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CqlLsProcess } from '../../src/jvm/cqlLsProcess.js';
import { findJavaRuntime } from '../../src/jvm/javaLocator.js';
import { DapSession } from '../../src/dap/dapSession.js';
import { runFileTool, runSuiteTool, listRunsTool, diffTool } from '../../src/tools/testPipelineTools.js';
import type { McpContext } from '../../src/tools/defs.js';
import { readLatestPointer } from '../../src/testPipeline/resultStore.js';

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

describe('test pipeline integration (real JVM)', () => {
  const java = findJavaRuntime(process.env.JAVA_HOME);
  const jar = findJar();
  const available = java !== null && jar !== null;

  let proc: CqlLsProcess | null = null;
  let workspaceRoot: string;
  let ctx: McpContext | null = null;
  let createdTempDir = false;

  before(async function () {
    if (!available) {
      this.skip();
      return;
    }
    console.log(`integration: java=${java!.javaPath} (v${java!.version}), jar=${jar}`);
    // The LS can only access files within its workspacePath. We mirror the
    // fixture tree (test-pipeline/CMSDemo/...) into a tempdir so the LS sees
    // the CQL files we need to execute.
    const realFixture = path.join(projectRoot, 'test', 'fixtures', 'test-pipeline');
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tpt-integration-'));
    const suiteName = 'CMSDemo';
    const dstLibraryDir = path.join(workspaceRoot, 'test', 'fixtures', 'test-pipeline', suiteName);
    fs.mkdirSync(dstLibraryDir, { recursive: true });
    fs.cpSync(path.join(realFixture, suiteName, `${suiteName}.cql`), path.join(dstLibraryDir, `${suiteName}.cql`));
    fs.cpSync(path.join(realFixture, suiteName, 'config.jsonc'), path.join(dstLibraryDir, 'config.jsonc'));
    fs.mkdirSync(path.join(dstLibraryDir, 'p1'), { recursive: true });
    fs.mkdirSync(path.join(dstLibraryDir, 'p2'), { recursive: true });
    fs.mkdirSync(path.join(dstLibraryDir, 'shared'), { recursive: true });
    createdTempDir = true;
    proc = new CqlLsProcess({
      javaPath: java!.javaPath,
      jarPath: jar!,
      workspacePath: workspaceRoot,
      logbackConfigFile: LOGBACK_FILE,
    });
    ctx = {
      process: proc,
      debugSession: {} as DapSession,
      jarPath: jar!,
      javaVersion: java!.version,
      workspaceRoot,
    };
    await proc.ensureReady();
  });

  after(async () => {
    await proc?.stop();
    if (createdTempDir && workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('cql_test_run_file persists a run and updates the latest pointer', async function () {
    if (!available) return this.skip();
    const cqlFile = path.join(workspaceRoot, 'test', 'fixtures', 'test-pipeline', 'CMSDemo', 'CMSDemo.cql');
    const result = (await runFileTool.handler(ctx!, {
      cqlFile,
      contextValues: ['p1', 'p2'],
      suiteName: 'CMSDemo',
    })) as { cases: Array<{ patientId: string; status: string; expressions: Array<{ name: string; value: string }> }>; counts: { total: number; passed: number }; hash: string };
    expect(result.cases).to.have.length(2);
    expect(result.counts.total).to.equal(2);
    expect(result.counts.passed).to.equal(2);
    expect(result.cases[0].expressions.map((e) => e.name)).to.include('One');
    expect(readLatestPointer(workspaceRoot, 'CMSDemo')?.hash).to.equal(result.hash);
  });

  it('cql_test_run_suite discovers Layout A test cases (skipping "shared")', async function () {
    if (!available) return this.skip();
    const cqlFile = path.join(workspaceRoot, 'test', 'fixtures', 'test-pipeline', 'CMSDemo', 'CMSDemo.cql');
    const suiteRoot = path.join(workspaceRoot, 'test', 'fixtures', 'test-pipeline');
    const result = (await runSuiteTool.handler(ctx!, {
      cqlFile,
      suiteRoot,
      suiteName: 'CMSDemo',
    })) as { cases: Array<{ patientId: string }>; counts: { total: number } };
    expect(result.cases.map((c) => c.patientId).sort()).to.deep.equal(['p1', 'p2']);
    expect(result.counts.total).to.equal(2);
  });

  it('cql_test_list_runs + cql_test_diff round-trip with real persisted runs', async function () {
    if (!available) return this.skip();
    const cqlFile = path.join(workspaceRoot, 'test', 'fixtures', 'test-pipeline', 'CMSDemo', 'CMSDemo.cql');
    // Run 1: p1, p2
    await runFileTool.handler(ctx!, { cqlFile, contextValues: ['p1', 'p2'], suiteName: 'DiffSuite' });
    await new Promise((r) => setTimeout(r, 5));
    // Run 2: p1, p2, p3
    await runFileTool.handler(ctx!, { cqlFile, contextValues: ['p1', 'p2', 'p3'], suiteName: 'DiffSuite' });

    const list = (await listRunsTool.handler(ctx!, { suiteName: 'DiffSuite' })) as {
      runs: Array<{ suiteName: string; testCaseCount: number }>;
    };
    expect(list.runs).to.have.length(2);
    expect(list.runs[0].testCaseCount).to.equal(3); // newest first
    expect(list.runs[1].testCaseCount).to.equal(2);

    const diff = (await diffTool.handler(ctx!, {
      suiteName: 'DiffSuite',
      runA: 'previous',
      runB: 'latest',
    })) as { added: Array<{ patientId: string }>; unchangedCount: number };
    expect(diff.added.map((c) => c.patientId)).to.deep.equal(['p3']);
    expect(diff.unchangedCount).to.equal(2);
  });
});
