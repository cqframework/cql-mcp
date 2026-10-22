/**
 * Pure types for the test pipeline. Mirrors vscode-cql/src/model/{testCase,parameters}.ts
 * and vscode-cql/src/helpers/cqlHelpers.ts:23-28 (TestConfig), with `vscode.Uri`
 * replaced by plain filesystem path strings.
 */

export interface TestCase {
  /** Test case directory name (the patient UUID for MADIE-style bundles). */
  name: string;
  /** Absolute path to the test case directory containing the FHIR resource files. */
  path: string;
}

export interface TestCaseExclusion {
  library: string;
  testCase: string;
  reason: string;
}

export interface MeasureReportPopulation {
  groupId: string;
  display: string;
  expected: number;
  code: string;
}

export interface MeasureReportData {
  patientId?: string;
  populations?: MeasureReportPopulation[];
  description?: string;
}

// --- Parameter types (ported from model/parameters.ts) ---

export type ParameterSource =
  | 'config-global'
  | 'config-library'
  | 'config-test-case'
  | 'default';

export interface ParameterEntry {
  name: string;
  type: string;
  value: string;
  /** Populated on output only — indicates which config tier supplied this parameter. */
  source?: ParameterSource;
}

export interface LibraryParameterBlock {
  library: string;
  version?: string;
  parameters?: ParameterEntry[];
  testCases?: Record<string, ParameterEntry[]>;
}

export type ParameterConfigEntry = ParameterEntry | LibraryParameterBlock;
export type CqlParametersConfig = ParameterConfigEntry[];

export interface ResultParameterEntry {
  name: string;
  type?: string;
  value: string;
  source: ParameterSource;
}

// --- Test config (ported from cqlHelpers.ts:23-28) ---

export interface TestConfig {
  testCasesToExclude: TestCaseExclusion[];
  parameters?: CqlParametersConfig;
  resultFormat: 'individual' | 'flat';
  flatResultsInSubfolder?: boolean;
}

export const DEFAULT_TEST_CONFIG: TestConfig = {
  testCasesToExclude: [],
  resultFormat: 'flat',
  flatResultsInSubfolder: false,
};

// --- Run record (new design) ---

export interface RunCaseResult {
  patientId: string;
  status: 'passed' | 'failed' | 'skipped' | 'errored';
  reason?: string;
  expressions: Array<{ name: string; value: string }>;
  errors: string[];
}

export interface RunRecord {
  hash: string;
  timestamp: string;
  suiteName: string;
  libraryName: string;
  libraryVersion: string | null;
  cqlFile: string;
  fhirVersion: string;
  configPath: string | null;
  cases: RunCaseResult[];
  counts: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    errored: number;
  };
  parametersApplied: ResultParameterEntry[];
  versions?: Record<string, string | undefined>;
}

export interface RunSummary {
  timestamp: string;
  hash: string;
  suiteName: string;
  libraryName: string;
  testCaseCount: number;
  passed: number;
  failed: number;
  passRate: number;
}

export type DiffEntry =
  | {
      kind: 'changed';
      patientId: string;
      before: { name: string; value: string };
      after: { name: string; value: string };
    }
  | { kind: 'added'; patientId: string; after: RunCaseResult }
  | { kind: 'removed'; patientId: string; before: RunCaseResult };

export type ExpressionChangeKind = 'value-changed' | 'expression-added' | 'expression-removed';

export interface DiffReport {
  suite: string;
  runA: string;
  runB: string;
  added: RunCaseResult[];
  removed: RunCaseResult[];
  changed: Array<{
    patientId: string;
    expressionName: string;
    before: string;
    after: string;
    /**
     * Defaults to 'value-changed' when omitted (backward-compatible with
     * consumers that pre-date the add/remove discrimination).
     */
    kind?: ExpressionChangeKind;
  }>;
  statusFlips: Array<{
    patientId: string;
    before: RunCaseResult['status'];
    after: RunCaseResult['status'];
  }>;
  unchangedCount: number;
  summary: string;
}

export interface NoPreviousRunReport {
  status: 'no_previous_run';
  suite: string;
  message: string;
}
