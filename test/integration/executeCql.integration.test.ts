import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CqlLsProcess } from '../../src/jvm/cqlLsProcess.js';
import { findJavaRuntime } from '../../src/jvm/javaLocator.js';
import { executeCql } from '../../src/lsp/lspCommands.js';
import { buildExecuteCqlRequest, openCqlFile } from '../../src/tools/executeCqlTool.js';
import { fixedRuntime } from '../helpers/fixedRuntime.js';

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
const fixture = (name: string) => path.join(projectRoot, 'test', 'fixtures', name);

// The 4.11.0-SNAPSHOT jar bundles a malformed logback.xml whose failed parse
// writes logback status to stdout before the first LSP frame. Point the JVM at
// the fixed source config so the LSP channel stays clean.
const LOGBACK_FILE =
  process.env.CQL_MCP_LOGBACK_FILE ??
  path.resolve(projectRoot, '..', 'cql-language-server', 'ls', 'server', 'src', 'main', 'resources', 'logback.xml');

function newProcess(java: { javaPath: string }, jar: string, workspacePath: string): CqlLsProcess {
  return new CqlLsProcess({ runtime: fixedRuntime(java.javaPath, jar), workspacePath, logbackConfigFile: LOGBACK_FILE });
}

describe('executeCql integration (real JVM)', () => {
  const java = findJavaRuntime(process.env.JAVA_HOME);
  const jar = findJar();
  const available = java !== null && jar !== null;

  before(function () {
    if (!available) {
      this.skip();
      return;
    }
    console.log(`integration: java=${java!.javaPath} (v${java!.version}), jar=${jar}`);
  });

  let proc: CqlLsProcess | null = null;

  after(async () => {
    await proc?.stop();
  });

  it('executes a basic library and returns expression values', async function () {
    if (!available) {
      this.skip();
      return;
    }
    proc = newProcess(java!, jar!, projectRoot);
    await proc.ensureReady();
    expect(proc.currentState).to.equal('ready');

    const cqlFile = fixture(path.join('basic', 'BasicLibrary.cql'));
    openCqlFile(proc.lspClient, cqlFile);
    const request = buildExecuteCqlRequest({ cqlFile });
    const response = await executeCql(proc.lspClient, request);

    expect(response.logs).to.be.an('array');
    const names = new Map<string, string>();
    for (const result of response.results) {
      expect(result.libraryName).to.equal('BasicLibrary');
      for (const expr of result.expressions) {
        names.set(expr.name, expr.value);
      }
    }
    expect(names.get('One')).to.equal('1');
    expect(names.get('Five')).to.equal('5');
    expect(names.get('Greeting')).to.contain('hello');
  });

  it('returns diagnostics (not a crash) for malformed CQL', async function () {
    if (!available) {
      this.skip();
      return;
    }
    if (!proc) {
      proc = newProcess(java!, jar!, projectRoot);
      await proc.ensureReady();
    }

    const cqlFile = fixture(path.join('malformed', 'BrokenLibrary.cql'));
    openCqlFile(proc.lspClient, cqlFile);
    const request = buildExecuteCqlRequest({ cqlFile });
    const response = await executeCql(proc.lspClient, request);

    // The LS returns compile errors as expressions named 'Error'; the server
    // must still be alive and ready afterwards.
    const hasDiagnostic =
      response.results.some((r) => r.expressions.some((e) => e.name === 'Error')) || response.logs.length > 0;
    expect(hasDiagnostic).to.equal(true);
    expect(proc!.currentState).to.equal('ready');
  });

  it('recovers via respawn after a forced JVM crash', async function () {
    if (!available) {
      this.skip();
      return;
    }
    const fresh = newProcess(java!, jar!, projectRoot);
    try {
      await fresh.ensureReady();
      fresh.debugChild?.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 1000));
      expect(fresh.currentState).to.equal('crashed');

      // ensureReady respawns; didOpen re-registers the CQL file on the new LS.
      await fresh.ensureReady();
      const cqlFile = fixture(path.join('basic', 'BasicLibrary.cql'));
      openCqlFile(fresh.lspClient, cqlFile);
      const request = buildExecuteCqlRequest({ cqlFile });
      const response = await executeCql(fresh.lspClient, request);

      const names = new Map<string, string>();
      for (const result of response.results) {
        for (const expr of result.expressions) {
          names.set(expr.name, expr.value);
        }
      }
      expect(names.get('One')).to.equal('1');
      expect(fresh.currentState).to.equal('ready');
    } finally {
      await fresh.stop();
    }
  });
});