import * as fs from 'node:fs';
import { LanguageServerCrashedError, type CqlLsProcess } from '../jvm/cqlLsProcess.js';
import { EXECUTE_CQL } from '../lsp/lspCommands.js';
import type { ExecuteCqlRequest, ExecuteCqlResponse } from '../lsp/protocol.js';
import {
  buildExecuteCqlRequest,
  openCqlFile,
  type CqlExecuteToolArgs,
} from '../tools/executeCqlTool.js';
import { loadTestConfig } from './configLoader.js';
import { resolveParameters } from './parametersMerger.js';
import {
  contentHash,
  saveRun,
  updatePointers,
} from './resultStore.js';
import { buildExclusionSet, loadSuite, getMeasureReportData } from './testCaseLoader.js';
import { fsSafeTimestamp } from '../workspace/paths.js';
import type {
  CqlParametersConfig,
  ParameterEntry,
  ResultParameterEntry,
  RunCaseResult,
  RunRecord,
  TestCase,
  TestConfig,
} from './testCaseModel.js';

export interface RunFileArgs {
  cqlFile: string;
  fhirVersion?: string;
  contextValues?: string[];
  parameters?: Array<{ name: string; type?: string; value: string }>;
  terminologyUri?: string;
  optionsPath?: string;
  rootDir?: string;
  libraryVersion?: string | null;
  suiteName?: string;
  /** Directory of FHIR resources to evaluate against. Without it no patient data is read. */
  modelUri?: string;
}

export interface RunSuiteArgs {
  cqlFile: string;
  fhirVersion?: string;
  suiteRoot: string;
  suiteName: string;
  configPath?: string | null;
  excludeTestCases?: string[];
  /** Overrides for the IG defaults derived from cqlFile (see igDefaultsFor). */
  rootDir?: string;
  terminologyUri?: string;
  optionsPath?: string;
}

export interface SuiteRunnerDeps {
  /** Underlying JVM process — provides ensureReady + executeCommand. */
  process: CqlLsProcess;
  /** Workspace root used as the parent of `<rootDir>/.cql-debug/test-runs/`. */
  workspaceRoot: string;
}

/**
 * Run a single CQL library against one or more patient/context values (one
 * library request per value). Always persists the result and updates the
 * per-suite pointer.
 */
export async function runFile(
  deps: SuiteRunnerDeps,
  args: RunFileArgs,
): Promise<RunRecord> {
  const suiteName = args.suiteName ?? defaultSuiteName(args.cqlFile);
  const contextValues = args.contextValues ?? [undefined];
  // Strip Windows-illegal chars (`:`, `.`) so `run.timestamp` and the
  // corresponding filename are both valid on NTFS (CLAUDE.md cross-platform).
  const startedAt = fsSafeTimestamp(new Date().toISOString());

  // Build a single request that may fan out to multiple library entries (one
  // per contextValue). The LS handles them all in one executeCql call.
  // The LS needs the libraryVersion to resolve the source — derive it from
  // the `library X version 'Y'` header when not explicitly provided.
  const resolvedLibraryVersion = args.libraryVersion ?? extractLibraryVersion(args.cqlFile) ?? null;
  const reqArgs: CqlExecuteToolArgs = {
    cqlFile: args.cqlFile,
    fhirVersion: args.fhirVersion ?? 'R4',
    contextValues: args.contextValues,
    parameters: args.parameters,
    terminologyUri: args.terminologyUri,
    optionsPath: args.optionsPath,
    rootDir: args.rootDir,
    libraryVersion: resolvedLibraryVersion,
    modelUri: args.modelUri,
  };

  await deps.process.ensureReady();
  const request = buildExecuteCqlRequest(reqArgs);
  // Mirror the editor behavior — see runSingleCase for rationale.
  openCqlFile(deps.process.lspClient, args.cqlFile);
  const raw = await deps.process.executeCommand(EXECUTE_CQL, [request]);
  const response = raw as ExecuteCqlResponse;

  const cases = response.results.map((libResult, i) => {
    const patientId = contextValues[i] ?? `no-context-${i + 1}`;
    return toCaseResult(patientId, libResult.expressions);
  });

  const counts = tally(cases);
  const run = buildRunRecord({
    suiteName,
    cqlFile: args.cqlFile,
    fhirVersion: args.fhirVersion ?? 'R4',
    libraryVersion: resolvedLibraryVersion,
    configPath: null,
    cases,
    counts,
    parametersApplied: [],
    versions: response.versions,
    startedAt,
    cqlParametersConfig: undefined,
    libraryName: libraryNameOfCqlFile(args.cqlFile),
  });

  saveRun(deps.workspaceRoot, run);
  updatePointers(deps.workspaceRoot, suiteName, run.hash);
  return run;
}

/**
 * Run a discovered MADIE-style suite (Layout A). Each test case under
 * `<suiteRoot>/<suiteName>/<patient-uuid-dir>/` becomes a contextValue. The
 * runner merges parameters per-case using config.jsonc (global + library +
 * per-testCase tiers) plus any caller-supplied excludeTestCases.
 *
 * Crash mid-run: the first LanguageServerCrashedError marks the failing case
 * as 'errored', then remaining cases become 'skipped' (LS will be respawned
 * transparently by the next call to process).
 */
export async function runSuite(
  deps: SuiteRunnerDeps,
  args: RunSuiteArgs,
): Promise<RunRecord> {
  // Strip Windows-illegal chars so the filename matches the JSON timestamp.
  const startedAt = fsSafeTimestamp(new Date().toISOString());
  const { config, configPath } = loadSuiteConfig(args.configPath);
  const excludedDirs = buildExclusionSet(
    config.testCasesToExclude.map((e) => e.testCase),
    args.excludeTestCases ?? [],
  );
  const discovered = loadSuite(args.suiteRoot, args.suiteName, excludedDirs);

  if (discovered.length === 0) {
    return persistEmptyRun(deps, args, startedAt, config, configPath);
  }

  // Read per-case MeasureReport patientIds (these override directory names
  // when present — that's how the extension maps test cases to patients).
  const cases: RunCaseResult[] = [];
  let crashed = false;
  const fhirVersion = args.fhirVersion ?? 'R4';
  const libraryName = libraryNameOfCqlFile(args.cqlFile);
  const libraryVersion = extractLibraryVersion(args.cqlFile);

  for (const testCase of discovered) {
    const patientId = resolvePatientId(testCase);
    if (crashed) {
      cases.push({
        patientId,
        status: 'skipped',
        reason: 'language_server_crashed',
        expressions: [],
        errors: [],
      });
      continue;
    }
    const caseParams = config.parameters
      ? resolveParameters(config.parameters, libraryName, libraryVersion, patientId)
      : [];
    try {
      const result = await runSingleCase(deps, args, testCase, patientId, caseParams, fhirVersion);
      cases.push(result);
    } catch (err) {
      if (err instanceof LanguageServerCrashedError) {
        crashed = true;
        cases.push({
          patientId,
          status: 'errored',
          reason: err.message,
          expressions: [],
          errors: err.crash.stderrTail ?? [],
        });
        continue;
      }
      throw err;
    }
  }

  const counts = tally(cases);
  const allParams: ResultParameterEntry[] = dedupeParameters(
    cases.flatMap((c) => collectParamsForCase(config.parameters, libraryName, libraryVersion, c.patientId)),
  );
  const run = buildRunRecord({
    suiteName: args.suiteName,
    cqlFile: args.cqlFile,
    fhirVersion,
    libraryVersion: libraryVersion ?? null,
    configPath,
    cases,
    counts,
    parametersApplied: allParams,
    versions: undefined,
    startedAt,
    cqlParametersConfig: config.parameters,
    libraryName,
  });
  saveRun(deps.workspaceRoot, run);
  updatePointers(deps.workspaceRoot, args.suiteName, run.hash);
  return run;
}

// --- Helpers ---

async function runSingleCase(
  deps: SuiteRunnerDeps,
  args: RunSuiteArgs,
  testCase: TestCase,
  patientId: string,
  caseParams: ParameterEntry[],
  fhirVersion: string,
): Promise<RunCaseResult> {
  const cqlFile = args.cqlFile;
  await deps.process.ensureReady();
  // The case folder is the data model. rootDir, terminologyUri and optionsPath default from the
  // IG (buildExecuteCqlRequest); without rootDir an IG library fails to compile, and without the
  // model it evaluates against no patient data.
  const request = buildExecuteCqlRequest({
    cqlFile,
    fhirVersion,
    contextValues: [patientId],
    parameters: caseParams.map((p) => ({ name: p.name, type: p.type, value: p.value })),
    libraryVersion: extractLibraryVersion(cqlFile) ?? null,
    modelUri: testCase.path,
    rootDir: args.rootDir,
    terminologyUri: args.terminologyUri,
    optionsPath: args.optionsPath,
  });
  // Mirror the editor behavior the VS Code extension provides for free:
  // the LS's FederatedLibrarySourceProvider resolves the CQL source through
  // ActiveContentService, which only sees documents we explicitly didOpen.
  openCqlFile(deps.process.lspClient, cqlFile);
  const raw = await deps.process.executeCommand(EXECUTE_CQL, [request]);
  const response = raw as ExecuteCqlResponse;
  const libResult = response.results[0];
  if (!libResult) {
    return {
      patientId,
      status: 'errored',
      reason: 'no_library_result',
      expressions: [],
      errors: ['executeCql returned no library results'],
    };
  }
  return toCaseResult(patientId, libResult.expressions);
}

function toCaseResult(
  patientId: string,
  expressions: Array<{ name: string; value: string }>,
): RunCaseResult {
  const errors: string[] = [];
  const ok: Array<{ name: string; value: string }> = [];
  for (const e of expressions) {
    if (e.name === 'Error') {
      errors.push(e.value);
    } else {
      ok.push(e);
    }
  }
  return {
    patientId,
    status: errors.length > 0 ? 'failed' : 'passed',
    expressions: ok,
    errors,
  };
}

function tally(cases: RunCaseResult[]): RunRecord['counts'] {
  const counts = { total: cases.length, passed: 0, failed: 0, skipped: 0, errored: 0 };
  for (const c of cases) {
    counts[c.status]++;
  }
  return counts;
}

function resolvePatientId(testCase: TestCase): string {
  const data = getMeasureReportData(testCase.path);
  return data?.patientId ?? testCase.name;
}

function libraryNameOfCqlFile(cqlFile: string): string {
  const base = cqlFile.split(/[\\/]/).filter(Boolean).pop() ?? cqlFile;
  return base.endsWith('.cql') ? base.slice(0, -'.cql'.length) : base;
}

function extractLibraryVersion(cqlFile: string): string | undefined {
  try {
    const text = fs.readFileSync(cqlFile, 'utf-8');
    return text.match(/^library\s+\S+\s+version\s+'([^']+)'/m)?.[1];
  } catch {
    return undefined;
  }
}

function defaultSuiteName(cqlFile: string): string {
  return libraryNameOfCqlFile(cqlFile);
}

function loadSuiteConfig(
  configPath: string | null | undefined,
): { config: TestConfig; configPath: string | null } {
  if (!configPath) {
    return {
      config: { testCasesToExclude: [], resultFormat: 'flat', flatResultsInSubfolder: false },
      configPath: null,
    };
  }
  return { config: loadTestConfig(configPath), configPath };
}

function collectParamsForCase(
  cfg: CqlParametersConfig | undefined,
  libraryName: string,
  libraryVersion: string | undefined,
  patientId: string,
): ResultParameterEntry[] {
  if (!cfg) {
    return [];
  }
  return resolveParameters(cfg, libraryName, libraryVersion, patientId).map(
    (p) => ({ name: p.name, type: p.type, value: p.value, source: p.source ?? 'config-global' }),
  );
}

function dedupeParameters(params: ResultParameterEntry[]): ResultParameterEntry[] {
  const map = new Map<string, ResultParameterEntry>();
  for (const p of params) {
    map.set(`${p.name}|${p.source}`, p);
  }
  return Array.from(map.values());
}

function persistEmptyRun(
  deps: SuiteRunnerDeps,
  args: RunSuiteArgs,
  startedAt: string,
  config: TestConfig,
  configPath: string | null,
): RunRecord {
  const run = buildRunRecord({
    suiteName: args.suiteName,
    cqlFile: args.cqlFile,
    fhirVersion: args.fhirVersion ?? 'R4',
    libraryVersion: null,
    configPath,
    cases: [],
    counts: { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 },
    parametersApplied: [],
    versions: undefined,
    startedAt,
    cqlParametersConfig: config.parameters,
    libraryName: libraryNameOfCqlFile(args.cqlFile),
  });
  saveRun(deps.workspaceRoot, run);
  updatePointers(deps.workspaceRoot, args.suiteName, run.hash);
  return run;
}

interface BuildRunRecordInput {
  suiteName: string;
  cqlFile: string;
  fhirVersion: string;
  libraryVersion: string | null;
  configPath: string | null;
  cases: RunCaseResult[];
  counts: RunRecord['counts'];
  parametersApplied: ResultParameterEntry[];
  versions: ExecuteCqlResponse['versions'] | undefined;
  startedAt: string;
  cqlParametersConfig: CqlParametersConfig | undefined;
  libraryName: string;
}

function buildRunRecord(input: BuildRunRecordInput): RunRecord {
  const hash = contentHash({
    suiteName: input.suiteName,
    cqlFile: input.cqlFile,
    libraryName: input.libraryName,
    libraryVersion: input.libraryVersion,
    parameters: input.cqlParametersConfig ?? [],
    contextValues: input.cases.map((c) => c.patientId),
  });
  return {
    hash,
    timestamp: input.startedAt,
    suiteName: input.suiteName,
    libraryName: input.libraryName,
    libraryVersion: input.libraryVersion,
    cqlFile: input.cqlFile,
    fhirVersion: input.fhirVersion,
    configPath: input.configPath,
    cases: input.cases,
    counts: input.counts,
    parametersApplied: input.parametersApplied,
    versions: input.versions,
  };
}
