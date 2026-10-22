import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CqlLsProcess } from '../../src/jvm/cqlLsProcess.js';
import { findJavaRuntime } from '../../src/jvm/javaLocator.js';
import { executeCql, VIEW_ELM } from '../../src/lsp/lspCommands.js';
import { buildExecuteCqlRequest, openCqlFile } from '../../src/tools/executeCqlTool.js';
import { pathToUri } from '../../src/workspace/paths.js';

function findJar(): string | null {
  const envJar = process.env.CQL_LS_JAR_PATH;
  if (envJar && fs.existsSync(envJar)) return envJar;
  const candidates = [
    path.resolve(process.cwd(), '..', 'vscode-cql', 'dist', 'java-support', 'jars'),
    path.resolve(process.cwd(), 'dist', 'java-support', 'jars'),
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const found = fs.readdirSync(dir).find((f) => f.startsWith('cql-ls-server-') && f.endsWith('.jar'));
    if (found) return path.join(dir, found);
  }
  return null;
}

const projectRoot = process.cwd();
const LOGBACK_FILE =
  process.env.CQL_DEBUG_MCP_LOGBACK_FILE ??
  path.resolve(projectRoot, '..', 'cql-language-server', 'ls', 'server', 'src', 'main', 'resources', 'logback.xml');

function values(response: { results: Array<{ expressions: Array<{ name: string; value: string }> }> }) {
  const m = new Map<string, string>();
  for (const r of response.results) for (const e of r.expressions) m.set(e.name, e.value);
  return m;
}

describe('documentSync integration (real JVM)', () => {
  const java = findJavaRuntime(process.env.JAVA_HOME);
  const jar = findJar();
  const available = java !== null && jar !== null;

  let proc: CqlLsProcess | null = null;
  let scratch: string;

  before(async function () {
    if (!available) {
      this.skip();
      return;
    }
    // A probe directory outside the server's workspace folder (projectRoot).
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cql-probe-'));
    proc = new CqlLsProcess({ javaPath: java!.javaPath, jarPath: jar!, workspacePath: projectRoot, logbackConfigFile: LOGBACK_FILE });
    await proc.ensureReady();
  });

  after(async () => {
    await proc?.stop();
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('executes a library that lives outside the workspace folder', async function () {
    if (!available) this.skip();
    const cqlFile = path.join(scratch, 'OutsideProbe.cql');
    fs.writeFileSync(cqlFile, 'library OutsideProbe\n\ndefine "Two": 1 + 1\n');
    openCqlFile(proc!.lspClient, cqlFile);
    const response = await executeCql(proc!.lspClient, buildExecuteCqlRequest({ cqlFile }));
    expect(values(response).get('Two')).to.equal('2');
  });

  it('returns ELM for the edited text, not the first compile', async function () {
    if (!available) this.skip();
    const cqlFile = path.join(scratch, 'ElmProbe.cql');
    const viewJson = async () =>
      (await proc!.executeCommand(VIEW_ELM, [pathToUri(cqlFile), 'json'])) as string;

    fs.writeFileSync(cqlFile, 'library ElmProbe\n\ndefine "Marker": 111\n');
    openCqlFile(proc!.lspClient, cqlFile);
    const first = await viewJson();
    expect(first).to.contain('"value":"111"');

    fs.writeFileSync(cqlFile, 'library ElmProbe\n\ndefine "Marker": 222\n');
    openCqlFile(proc!.lspClient, cqlFile);
    const second = await viewJson();
    expect(second).to.contain('"value":"222"');
    expect(second).not.to.contain('"value":"111"');
  });

  it('control: a repeated didOpen alone leaves the stale compile in place', async function () {
    // Documents the server behaviour the fix works around. If this starts failing, the language
    // server now invalidates its compile cache on didOpen and the workaround could be simplified.
    if (!available) this.skip();
    const cqlFile = path.join(scratch, 'StaleControl.cql');
    const uri = pathToUri(cqlFile);
    const open = (text: string) =>
      proc!.lspClient.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId: 'cql', version: 1, text },
      });
    fs.writeFileSync(cqlFile, 'library StaleControl\n\ndefine "Marker": 333\n');
    openCqlFile(proc!.lspClient, cqlFile); // registers the scratch folder; first open
    await proc!.executeCommand(VIEW_ELM, [uri, 'json']);
    fs.writeFileSync(cqlFile, 'library StaleControl\n\ndefine "Marker": 444\n');
    open('library StaleControl\n\ndefine "Marker": 444\n');
    const second = (await proc!.executeCommand(VIEW_ELM, [uri, 'json'])) as string;
    expect(second).to.contain('"value":"333"');
  });
});
