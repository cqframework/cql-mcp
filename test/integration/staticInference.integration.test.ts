import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CqlLsProcess } from '../../src/jvm/cqlLsProcess.js';
import { findJavaRuntime } from '../../src/jvm/javaLocator.js';
import { signaturesTool } from '../../src/tools/signaturesTool.js';
import { resolveIncludesTool } from '../../src/tools/resolveIncludesTool.js';
import { validateTool } from '../../src/tools/validateTool.js';
import type { McpContext } from '../../src/tools/defs.js';

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
    try {
      if (!fs.existsSync(dir)) {
        continue;
      }
      const found = fs.readdirSync(dir).find((f) => f.startsWith('cql-ls-server-') && f.endsWith('.jar'));
      if (found) {
        return path.join(dir, found);
      }
    } catch {
      // Ignore EPERM in sandboxed environments
    }
  }
  return null;
}

const projectRoot = process.cwd();
const fixture = (name: string) => path.join(projectRoot, 'test', 'fixtures', name);

const LOGBACK_FILE =
  process.env.CQL_MCP_LOGBACK_FILE ??
  path.resolve(projectRoot, '..', 'cql-language-server', 'ls', 'server', 'src', 'main', 'resources', 'logback.xml');

describe('staticInference integration (real JVM)', () => {
  const java = findJavaRuntime();
  const jar = findJar();
  const available = java !== null && jar !== null;

  before(function () {
    if (!available) {
      this.skip();
      return;
    }
  });

  let proc: CqlLsProcess | null = null;
  let context: McpContext | null = null;

  before(async () => {
    if (!available) return;
    proc = new CqlLsProcess({
      javaPath: java!.javaPath,
      jarPath: jar!,
      workspacePath: projectRoot,
      logbackConfigFile: LOGBACK_FILE,
    });
    await proc.ensureReady();
    context = {
      process: proc,
      debugSession: {} as any,
      jarPath: jar!,
      javaVersion: java!.version,
      workspaceRoot: projectRoot,
    };
  });

  after(async () => {
    await proc?.stop();
  });

  it('cql_get_signatures extracts defines and compiled return types from BasicLibrary.cql', async () => {
    const basicCql = fixture(path.join('basic', 'BasicLibrary.cql'));
    const result = (await signaturesTool.handler(context!, { cqlFile: basicCql })) as any;

    expect(result.library.name).to.equal('BasicLibrary');
    const defineNames = result.defines.map((d: any) => d.name);
    expect(defineNames).to.include.members(['One', 'Five', 'Greeting']);

    const oneDef = result.defines.find((d: any) => d.name === 'One');
    expect(oneDef?.returnType).to.equal('System.Integer');

    const greetingDef = result.defines.find((d: any) => d.name === 'Greeting');
    expect(greetingDef?.returnType).to.equal('System.String');
  });

  it('cql_resolve_includes resolves CommonHelper and extracts its public defines and functions', async () => {
    const mainCql = fixture(path.join('ig-minimal-with-include', 'input', 'cql', 'MainMeasure.cql'));
    const result = (await resolveIncludesTool.handler(context!, { cqlFile: mainCql })) as any;

    expect(result.includes).to.have.length(1);
    const inc = result.includes[0];
    expect(inc.alias).to.equal('Helper');
    expect(inc.libraryName).to.equal('CommonHelper');
    expect(inc.resolvedPath).to.include('CommonHelper.cql');
    expect(inc.signatures).to.be.ok;

    const defineNames = inc.signatures.defines.map((d: any) => d.name);
    expect(defineNames).to.include('Threshold');

    const funcNames = inc.signatures.functions.map((f: any) => f.name);
    expect(funcNames).to.include('AddTen');
    const addTen = inc.signatures.functions.find((f: any) => f.name === 'AddTen');
    expect(addTen?.parameters).to.deep.equal([{ name: 'val', type: 'System.Integer' }]);
    expect(addTen?.returnType).to.equal('System.Integer');
  });

  it('cql_validate reports valid on valid BasicLibrary.cql', async () => {
    const basicCql = fixture(path.join('basic', 'BasicLibrary.cql'));
    const result = (await validateTool.handler(context!, { cqlFile: basicCql })) as any;

    expect(result.valid).to.be.true;
    expect(result.errorCount).to.equal(0);
  });

  it('cql_validate reports syntax errors on malformed in-memory content', async () => {
    const basicCql = fixture(path.join('basic', 'BasicLibrary.cql'));
    const malformed = 'library BasicLibrary version \'1.0.0\'\ndefine "Broken": 1 + + * 5\n';
    const result = (await validateTool.handler(context!, {
      cqlFile: basicCql,
      content: malformed,
    })) as any;

    expect(result.valid).to.be.false;
    expect(result.errorCount).to.be.greaterThan(0);
    expect(result.diagnostics.length).to.be.greaterThan(0);
  });
});
