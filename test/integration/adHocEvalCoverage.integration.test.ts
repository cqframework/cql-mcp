import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CqlLsProcess } from '../../src/jvm/cqlLsProcess.js';
import { findJavaRuntime } from '../../src/jvm/javaLocator.js';
import { DapSession, type DapEvaluationResult, type DapStopEvent } from '../../src/dap/dapSession.js';
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
const fixtureDir = path.join(projectRoot, 'test', 'fixtures', 'ad-hoc-eval');
const fixture = (name: string): string => path.join(fixtureDir, name);

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

/**
 * Mirrors the coverage matrix in
 * `cql-language-server/ls/server/src/test/kotlin/org/opencds/cqf/cql/debug/AD_HOC_EVAL_COVERAGE.md`.
 * Step IDs TB-01… map 1:1 to that document's Tier B column. Only data-free, deterministic rows are
 * pinned here (live alias/retrieve rows are JUnit-only or documented in the runbook). `DapSession`'
 * `evaluate(expression, frameId)` always sends `context: 'repl'`, so the watch half of the matrix
 * (G1) is never reachable from Tier B.
 */
describe('adHocEvalCoverage integration (real JVM + DAP)', () => {
  const java = findJavaRuntime(process.env.JAVA_HOME);
  const jar = findJar();
  const available = java !== null && jar !== null;

  before(function () {
    if (!available) {
      this.skip();
      return;
    }
    console.log(`adHocEvalCoverage: java=${java!.javaPath} (v${java!.version}), jar=${jar}`);
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
  const procs: CqlLsProcess[] = [];
  const sessions: DapSession[] = [];

  after(async () => {
    // Tear down EVERY process/session this suite spawned — each `it` boots its own JVM,
    // and stopping only the last one leaves earlier JVMs holding stdio pipes open, which
    // prevents mocha from exiting after the summary prints.
    await Promise.all([...sessions].reverse().map((s) => s.stop()));
    await Promise.all([...procs].reverse().map((p) => p.stop()));
  });

  /** Fresh process + session, paused on `line` inside `cqlFile`. */
  async function launchAndPause(
    cqlFile: string,
    line: number,
    launchExtra?: { rootDir?: string },
  ): Promise<{ frameId: number; stop: DapStopEvent }> {
    proc = newProcess(java!, jar!, projectRoot);
    procs.push(proc);
    await proc.ensureReady();
    expect(proc.currentState).to.equal('ready');
    session = new DapSession({ ls: proc, resumeTimeoutMs: 15_000 });
    sessions.push(session);
    await session.start({ cqlFile, ...launchExtra });
    expect(session.isActive).to.equal(true);
    const bps = await session.setBreakpoints(cqlFile, [line]);
    expect(bps).to.have.length(1);
    const stop = await session.continue(1);
    expect(stop.event).to.equal('stopped');
    expect(stop.topFrame).to.exist;
    expect(stop.topFrame?.source?.path).to.equal(cqlFile);
    return { frameId: stop.topFrame!.id, stop };
  }

  /** Table-driven evaluate round-trips; logs every actual result. */
  async function evalRows(
    frameId: number,
    rows: Array<{ step: string; expression: string; expected?: string; prefix?: string; contains?: string[] }>,
  ): Promise<void> {
    for (const row of rows) {
      const res: DapEvaluationResult = await session!.evaluate(row.expression, frameId);
      process.stdout.write(
        `[adHocEvalCoverage] ${row.step} ${JSON.stringify(row.expression)} => ${JSON.stringify(res.result)}\n`,
      );
      if (row.expected !== undefined) {
        expect(res.result, `${row.step} ${row.expression}`).to.equal(row.expected);
      }
      if (row.prefix !== undefined) {
        expect(res.result, `${row.step} ${row.expression}`).to.match(new RegExp(`^${row.prefix}`));
      }
      for (const frag of row.contains ?? []) {
        expect(res.result, `${row.step} ${row.expression}`).to.include(frag);
      }
    }
  }

  it('TB-01…09 repl rows against AdHocQueryBasics (matrix rows 1, 4–9)', async function () {
    if (!available) {
      this.skip();
      return;
    }
    this.timeout(90_000);
    const cqlFile = fixture('AdHocQueryBasics.cql');
    // Pause inside the "Items" define (line 4 = its tuple-literal list).
    const { frameId } = await launchAndPause(cqlFile, 4);
    await evalRows(frameId, [
      { step: 'TB-01', expression: '1 + 2', expected: '3' },
      { step: 'TB-02', expression: 'Count("Items")', expected: '3' },
      { step: 'TB-03', expression: 'Count(from "Items" I where I.score >= 90)', expected: '2' },
      {
        step: 'TB-04',
        expression: 'Count(from "Items" I let Doubled: I.score * 2 where Doubled > 180)',
        expected: '2',
      },
      { step: 'TB-05', expression: 'exists (from "Items" I where I.score >= 95)', expected: 'true' },
      { step: 'TB-06', expression: 'First(from "Items" I sort by score desc).name', expected: "'charlie'" },
      { step: 'TB-07', expression: 'Interval[1, 10]', expected: '[1, 10]' },
      { step: 'TB-08', expression: "Tuple { a: 1, b: 'two' }", expected: "Tuple { a: 1, b: 'two' }" },
      // Missing-identifier compile error surfaces as a Compile error: response.
      { step: 'TB-09', expression: 'Count("No Such Define")', prefix: 'Compile error:' },
    ]);
  });

  it('TB-10…13 repl rows against AdHocTerminology (matrix rows 10–13)', async function () {
    if (!available) {
      this.skip();
      return;
    }
    this.timeout(90_000);
    const cqlFile = fixture('AdHocTerminology.cql');
    // Pause inside "Choice Shaped" (line 16 = its `if` line); every define is declared there
    // in sorted-by-name order so ExpressionRefs stay binary-search-discoverable (see matrix gap 3).
    const { frameId } = await launchAndPause(cqlFile, 16);
    await evalRows(frameId, [
      { step: 'TB-10', expression: 'First({ "Systolic BP Code" }).code', expected: "'8480-6'" },
      { step: 'TB-11', expression: 'Count("Quantity Alias")', expected: '2' },
      { step: 'TB-12', expression: 'Count("Nested Tuples")', expected: '2' },
      // Definition-rooted identifier-shaped expressions short-circuit pre-compile (matrix gap 2).
      {
        step: 'TB-13',
        expression: '"Code Selector".code',
        expected: "Identifier doesn't exist (CQL is case-sensitive)",
      },
    ]);
  });

  it('TB-14…15 code equivalence (~) rows against AdHocVitalSigns (matrix rows 33–34)', async function () {
    if (!available) {
      this.skip();
      return;
    }
    this.timeout(90_000);
    const cqlFile = fixture('AdHocVitalSigns.cql');
    // Pause inside "Blood Pressure Reading" (line 18 = its retrieve expression). With
    // no bound data the retrieve degrades (documented in the runbook); the paused
    // library still gives the `~` ad-hoc rows their code declarations.
    const { frameId } = await launchAndPause(cqlFile, 18);
    await evalRows(frameId, [
      {
        step: 'TB-14',
        expression:
          'exists (({ "Systolic blood pressure", "Diastolic blood pressure" }) C where C ~ "Systolic blood pressure")',
        expected: 'true',
      },
      {
        step: 'TB-15',
        expression:
          'exists (({ "Systolic blood pressure" }) C where C ~ "Diastolic blood pressure")',
        expected: 'false',
      },
    ]);
  });

  it('TB-16…17 smoke rows against AdHocFhirQuery (matrix row 26 + data-capture)', async function () {
    if (!available) {
      this.skip();
      return;
    }
    this.timeout(90_000);
    const cqlFile = fixture('AdHocFhirQuery.cql');
    // Pause inside "Encounter Period Test" (line 12 = its retrieve expression).
    const { frameId } = await launchAndPause(cqlFile, 12);
    // Baseline: pure arithmetic in a `using FHIR` library still evaluates.
    await evalRows(frameId, [{ step: 'TB-16', expression: '1 + 2', expected: '3' }]);
    // Data-capture row: with a live data provider the retrieve is usually empty (=> false);
    // without one it degrades to a Runtime error. Not pinned — recorded for the runbook.
    const res: DapEvaluationResult = await session!.evaluate('Exists(from [Encounter] E)', frameId);
    process.stdout.write(
      `[adHocEvalCoverage] TB-17 Exists(from [Encounter] E) => ${JSON.stringify(res.result)}\n`,
    );
    expect(res).to.have.property('result');
  });

  it('TB-18 cross-library qualified rows against AdHocIncludingLib (matrix rows 23–24, reachable subset)', async function () {
    if (!available) {
      this.skip();
      return;
    }
    this.timeout(120_000);
    const including = fixture('AdHocIncludingLib.cql');
    // Launch the including library; the included lib resolves through the fixtures dir.
    // NOTE: a breakpoint on the INCLUDED library's own file does not pause in CONTINUE mode
    // (the streaming handler logs `libBreakpoints=null` for included libraries) — so the
    // "T" Tuple-alias frame (matrix rows 23–24 exact pause) stays JUnit-only via G4. We pin
    // the reachable subset here: qualified defines across the include, paused in the primary.
    const { frameId } = await launchAndPause(including, 6, { rootDir: fixtureDir });
    await evalRows(frameId, [
      // Qualified define ref across the include, function-wrapped -> evaluates.
      { step: 'TB-18a', expression: 'Count(AdHocIncludedLib."Tuple Items")', expected: '2' },
      // Qualified define + index + property (not identifier-shaped) -> evaluates.
      { step: 'TB-18b', expression: 'AdHocIncludedLib."Tuple Items"[0].id', expected: '1' },
      // Bare qualified-delimited define root is NOT identifier-shaped (parseIdentifier returns
      // null for `Lib."Define with space"`), so it COMPILES and evaluates to the tuple list —
      // the opposite of simple `"Code Selector".code` in TB-13. Content-asserted (format varies).
      {
        step: 'TB-18c',
        expression: 'AdHocIncludedLib."Tuple Items"',
        contains: ['Tuple {', "'one'", "'two'"],
      },
    ]);
  });
});