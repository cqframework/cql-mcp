import * as path from 'node:path';
import type { CqlLsProcess } from '../jvm/cqlLsProcess.js';
import { diffRunsOrNoPrevious } from '../testPipeline/diff.js';
import {
  listRuns as resultStoreListRuns,
  loadRun as resultStoreLoadRun,
  readLatestPointer,
  readPreviousPointer,
} from '../testPipeline/resultStore.js';
import { runFile, runSuite } from '../testPipeline/suiteRunner.js';
import type { Tool } from './defs.js';
import { missing, expectString } from './defs.js';

// Shared by both run tools so callers read the status the way it is computed (suiteRunner.toCaseResult).
const CASE_STATUS_NOTE =
  'Case status: passed = evaluated with no Error entries; failed = the language server returned Error ' +
  'entries (e.g. compile errors); errored = the language server crashed on this case; skipped = not run ' +
  'after a crash. Status is NOT a comparison against expected results (MeasureReport / TestCaseResult).';

const IG_DEFAULTS_NOTE =
  'For a cqlFile in the IG Publisher default layout (<root>/input/cql/*.cql with an ig.ini at <root> or ' +
  'above), rootDir, terminologyUri and optionsPath default to <root> and the default-layout paths ' +
  '<root>/input/vocabulary/valueset and <root>/input/cql/cql-options.json; explicit arguments override.';

function ensureDeps(process: CqlLsProcess, workspaceRoot: string) {
  return { process, workspaceRoot };
}

const COMMON_PROPS = (suiteName: string | null) => ({
  suiteName: {
    type: 'string',
    description: suiteName ? `Suite (library) name. ${suiteName}` : 'Suite (library) name.',
  },
  workspaceRoot: {
    type: 'string',
    description: 'Workspace root under which .cql-debug/test-runs is stored. Defaults to MCP CWD.',
  },
});

export const runFileTool: Tool = {
  name: 'cql_test_run_file',
  description:
    'Run a single CQL file against one or more context values (one library request per value), ' +
    'persist the result, and update the latest/previous pointer for the suite. ' +
    'Returns the persisted RunRecord (counts + per-case results). Patient data is only read when modelUri ' +
    'is set (use cql_test_run_suite for test-case folders). ' +
    IG_DEFAULTS_NOTE +
    ' ' +
    CASE_STATUS_NOTE,
  inputSchema: {
    type: 'object',
    properties: {
      cqlFile: { type: 'string', description: 'Path to the .cql file to execute' },
      fhirVersion: { type: 'string', description: 'FHIR version, e.g. R4 (default R4)', default: 'R4' },
      contextValues: {
        type: 'array',
        items: { type: 'string' },
        description: 'Patient/context values to run against (one library request per value)',
      },
      parameters: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, type: { type: 'string' }, value: { type: 'string' } },
          required: ['name', 'value'],
        },
      },
      terminologyUri: { type: 'string' },
      optionsPath: { type: 'string' },
      rootDir: { type: 'string' },
      libraryVersion: { type: 'string' },
      modelUri: {
        type: 'string',
        description: 'Directory of FHIR resources (e.g. one test-case folder) to evaluate against.',
      },
      suiteName: {
        type: 'string',
        description:
          'Logical suite name. Defaults to the CQL file stem. Used to group runs in listings and diffs.',
      },
      workspaceRoot: COMMON_PROPS(null).workspaceRoot,
    },
    required: ['cqlFile'],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const m = missing(args, 'cqlFile');
    if (m) throw new Error(m);
    const cqlFile = path.resolve(args.cqlFile as string);
    const workspaceRoot = (args.workspaceRoot as string | undefined) ?? ctx.workspaceRoot;
    return runFile(ensureDeps(ctx.process, workspaceRoot), {
      cqlFile,
      fhirVersion: (args.fhirVersion as string | undefined) ?? 'R4',
      contextValues: (args.contextValues as string[] | undefined) ?? [],
      parameters: args.parameters as Array<{ name: string; type?: string; value: string }> | undefined,
      terminologyUri: args.terminologyUri as string | undefined,
      optionsPath: args.optionsPath as string | undefined,
      rootDir: args.rootDir as string | undefined,
      libraryVersion: (args.libraryVersion as string | null | undefined) ?? null,
      suiteName: args.suiteName as string | undefined,
      modelUri: args.modelUri ? path.resolve(args.modelUri as string) : undefined,
    });
  },
};

export const runSuiteTool: Tool = {
  name: 'cql_test_run_suite',
  description:
    'Discover test cases under `<suiteRoot>/<suiteName>/<patient-uuid>/` (Layout A), merge per-case ' +
    'parameters from a config.jsonc file (with caller-supplied exclusions unioned in), run each case, ' +
    'persist the result, and update the latest/previous pointer. The `shared` directory is always excluded. ' +
    "Each case is evaluated against its own folder's FHIR resources. " +
    IG_DEFAULTS_NOTE +
    ' ' +
    CASE_STATUS_NOTE,
  inputSchema: {
    type: 'object',
    properties: {
      cqlFile: { type: 'string', description: 'Path to the .cql library file' },
      suiteRoot: {
        type: 'string',
        description:
          'Parent directory containing one subdirectory per library/suite (Layout A: each subdirectory contains test-case dirs).',
      },
      suiteName: { type: 'string', description: 'Suite (library) name — selects the subdirectory under suiteRoot.' },
      configPath: {
        type: 'string',
        description:
          'Optional path to a .jsonc config file. Loads .jsonc preferentially over .json if both exist at the same path.',
      },
      excludeTestCases: {
        type: 'array',
        items: { type: 'string' },
        description: 'Test case (subdirectory) names to exclude; unioned with config.testCasesToExclude.',
      },
      fhirVersion: { type: 'string', description: 'FHIR version (default R4)', default: 'R4' },
      rootDir: { type: 'string', description: 'IG project root. Defaults to the IG root of cqlFile.' },
      terminologyUri: {
        type: 'string',
        description: 'Terminology directory. Defaults to <IG root>/input/vocabulary/valueset.',
      },
      optionsPath: {
        type: 'string',
        description: 'cql-options file. Defaults to <IG root>/input/cql/cql-options.json.',
      },
      workspaceRoot: COMMON_PROPS(null).workspaceRoot,
    },
    required: ['cqlFile', 'suiteRoot', 'suiteName'],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const miss =
      missing(args, 'cqlFile') ?? missing(args, 'suiteRoot') ?? missing(args, 'suiteName');
    if (miss) throw new Error(miss);
    const cqlFile = path.resolve(args.cqlFile as string);
    const suiteRoot = path.resolve(args.suiteRoot as string);
    const suiteName = args.suiteName as string;
    const configPath = args.configPath ? path.resolve(args.configPath as string) : null;
    const workspaceRoot = (args.workspaceRoot as string | undefined) ?? ctx.workspaceRoot;
    return runSuite(ensureDeps(ctx.process, workspaceRoot), {
      cqlFile,
      fhirVersion: (args.fhirVersion as string | undefined) ?? 'R4',
      suiteRoot,
      suiteName,
      configPath,
      excludeTestCases: args.excludeTestCases as string[] | undefined,
      rootDir: args.rootDir as string | undefined,
      terminologyUri: args.terminologyUri as string | undefined,
      optionsPath: args.optionsPath as string | undefined,
    });
  },
};

export const listRunsTool: Tool = {
  name: 'cql_test_list_runs',
  description:
    'List previously persisted test runs (newest-first). Optionally filter by suite and limit the count.',
  inputSchema: {
    type: 'object',
    properties: {
      suiteName: COMMON_PROPS('Filters to runs of this suite only.').suiteName,
      limit: { type: 'integer', description: 'Maximum number of runs to return', minimum: 1 },
      workspaceRoot: COMMON_PROPS(null).workspaceRoot,
    },
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const workspaceRoot = (args.workspaceRoot as string | undefined) ?? ctx.workspaceRoot;
    return {
      runs: resultStoreListRuns(workspaceRoot, {
        suiteName: args.suiteName as string | undefined,
        limit: args.limit as number | undefined,
      }),
    };
  },
};

interface DiffArgs {
  runA?: string;
  runB?: string;
  suiteName: string;
  workspaceRoot: string;
}

export const diffTool: Tool = {
  name: 'cql_test_diff',
  description:
    'Diff two persisted runs for the same suite. Either provide two hash-or-timestamp strings via runA/runB, ' +
    'or pass "latest"/"previous" to use the pointer files for the suite. If no previous run has been recorded, ' +
    'returns a no_previous_run status (not an error).',
  inputSchema: {
    type: 'object',
    properties: {
      suiteName: COMMON_PROPS('Required. Suite whose runs should be diffed.').suiteName,
      runA: {
        type: 'string',
        description:
          'Hash prefix (8+ chars) or timestamp (or timestamp prefix) of the first run, as listed by cql_test_list_runs ' +
          '(ISO form with ":" and "." also accepted, any case). Use "latest" or "previous" to use pointer files.',
      },
      runB: {
        type: 'string',
        description:
          'Hash prefix (8+ chars) or timestamp (or timestamp prefix) of the second run, as listed by cql_test_list_runs ' +
          '(ISO form with ":" and "." also accepted, any case). Use "latest" or "previous" to use pointer files.',
      },
      workspaceRoot: COMMON_PROPS(null).workspaceRoot,
    },
    required: ['suiteName', 'runA', 'runB'],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const suiteName = args.suiteName as string;
    const typeErr =
      expectString(args, 'suiteName') ?? expectString(args, 'runA') ?? expectString(args, 'runB');
    if (typeErr) throw new Error(typeErr);
    const workspaceRoot = (args.workspaceRoot as string | undefined) ?? ctx.workspaceRoot;

    const refA = (args.runA as string).trim();
    const refB = (args.runB as string).trim();

    // Only the pointer keywords are case-insensitive here; hashes and timestamps go to loadRun
    // as given, which does its own case-insensitive matching.
    const resolveRef = (ref: string): string | null => {
      const keyword = ref.toLowerCase();
      if (keyword === 'latest') {
        return readLatestPointer(workspaceRoot, suiteName)?.hash ?? null;
      }
      if (keyword === 'previous') {
        return readPreviousPointer(workspaceRoot, suiteName)?.hash ?? null;
      }
      return ref; // treat as hash or timestamp
    };

    const hashA = resolveRef(refA);
    const hashB = resolveRef(refB);
    if (!hashA || !hashB) {
      return {
        status: 'no_previous_run' as const,
        suite: suiteName,
        message: !hashA
          ? `No previous run found for ref "${args.runA}" in suite "${suiteName}".`
          : `No previous run found for ref "${args.runB}" in suite "${suiteName}".`,
      };
    }

    const before = resultStoreLoadRun(workspaceRoot, hashA);
    const after = resultStoreLoadRun(workspaceRoot, hashB);
    if (!before || !after) {
      throw new Error(
        `Could not load both runs for suite "${suiteName}": ` +
          `runA=${hashA.slice(0, 8)} ${before ? 'OK' : 'MISSING'}, ` +
          `runB=${hashB.slice(0, 8)} ${after ? 'OK' : 'MISSING'}`,
      );
    }
    return diffRunsOrNoPrevious(suiteName, before, after);
  },
};

export function buildTestPipelineTools(): Tool[] {
  return [runFileTool, runSuiteTool, listRunsTool, diffTool];
}
