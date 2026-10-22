import type { DapSession, DebugLaunchArgs, StepGranularity } from '../dap/dapSession.js';
import { missing } from './defs.js';
import type { Tool } from './defs.js';

type StepGranularityResult =
  | { ok: true; value: StepGranularity | undefined }
  | { ok: false; error: string };

function stepGranularityOf(raw: unknown): StepGranularityResult {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') {
    return { ok: false, error: `stepGranularity must be a string; got ${typeof raw}` };
  }
  const norm = raw.toLowerCase();
  if (norm === 'ast') return { ok: true, value: 'ast' };
  if (norm === 'cql') return { ok: true, value: 'cql' };
  return { ok: false, error: `stepGranularity must be 'cql' or 'ast'; got '${raw}'` };
}

function extractString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== 'string') return undefined;
  return v;
}

function extractLaunchArgs(args: Record<string, unknown>): DebugLaunchArgs {
  if (typeof args.cqlFile !== 'string') {
    throw new Error('Missing required argument: cqlFile');
  }
  const out: DebugLaunchArgs = { cqlFile: args.cqlFile };
  const fhirVersion = extractString(args, 'fhirVersion');
  if (fhirVersion) out.fhirVersion = fhirVersion;
  const testCaseName = extractString(args, 'testCaseName');
  if (testCaseName) out.testCaseName = testCaseName;
  const testCaseDir = extractString(args, 'testCaseDir');
  if (testCaseDir) out.testCaseDir = testCaseDir;
  const terminologyUri = extractString(args, 'terminologyUri');
  if (terminologyUri) out.terminologyUri = terminologyUri;
  const rootDir = extractString(args, 'rootDir');
  if (rootDir) out.rootDir = rootDir;
  const optionsPath = extractString(args, 'optionsPath');
  if (optionsPath) out.optionsPath = optionsPath;
  const sg = stepGranularityOf(args.stepGranularity);
  if (!sg.ok) {
    throw new Error(sg.error);
  }
  if (sg.value) out.stepGranularity = sg.value;
  if (args.parameters && typeof args.parameters === 'object') {
    out.parameters = args.parameters as Record<string, unknown>;
  }
  if (Array.isArray(args.breakpoints)) {
    out.breakpoints = args.breakpoints.filter(
      (n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0,
    );
  }
  return out;
}

export function buildDebugTools(session: DapSession): Tool[] {
  return [
    {
      name: 'cql_debug_start',
      description:
        "Start a DAP debug session for a CQL library. Chains LSP `startDebugSession` " +
        '→ TCP connect → DAP `initialize`/`launch`/`configurationDone` in a single call so ' +
        'the LS 10-second accept window is not missed. Optionally pass `breakpoints` to set ' +
        'them before launch (via the LS pre-launch breakpoints fallback), avoiding a separate ' +
        'cql_debug_set_breakpoints round-trip. Enforces a single active session: ' +
        'call cql_debug_stop first if one is already running. Pass cqlFile as the path to ' +
        'a .cql file (the tool internally computes both DAP-form and executeCql-form URIs).',
      inputSchema: {
        type: 'object',
        properties: {
          cqlFile: { type: 'string', description: 'Absolute path to the .cql file' },
          fhirVersion: { type: 'string', description: 'FHIR version (default R4)' },
          testCaseName: { type: 'string', description: 'MADIE bundle name to run' },
          testCaseDir: { type: 'string', description: 'Path to MADIE test-case bundle directory' },
          terminologyUri: { type: 'string' },
          rootDir: { type: 'string' },
          optionsPath: { type: 'string' },
          stepGranularity: {
            type: 'string',
            enum: ['ast', 'cql'],
            description: 'AST-level stepping when "ast", CQL-line-level otherwise (default "cql")',
          },
          parameters: { type: 'object', description: 'CQL parameter values keyed by name' },
          breakpoints: {
            type: 'array',
            items: { type: 'integer' },
            description: '1-indexed line numbers to set on cqlFile before launch',
          },
        },
        required: ['cqlFile'],
        additionalProperties: false,
      },
      handler: async (_ctx, args) => {
        const launchArgs = extractLaunchArgs(args);
        await session.start(launchArgs);
        return { active: true };
      },
    },
    {
      name: 'cql_debug_set_breakpoints',
      description: 'Set breakpoints (line numbers) in a CQL file.',
      inputSchema: {
        type: 'object',
        properties: {
          cqlFile: { type: 'string', description: 'Absolute path to the .cql file' },
          lines: {
            type: 'array',
            items: { type: 'integer' },
            description: '1-indexed line numbers',
          },
        },
        required: ['cqlFile', 'lines'],
        additionalProperties: false,
      },
      handler: async (_ctx, args) => {
        if (missing(args, 'cqlFile')) throw new Error(missing(args, 'cqlFile')!);
        if (missing(args, 'lines')) throw new Error(missing(args, 'lines')!);
        const lines = (args.lines as unknown[])
          .filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0);
        const breakpoints = await session.setBreakpoints(String(args.cqlFile), lines);
        return { breakpoints };
      },
    },
    {
      name: 'cql_debug_continue',
      description:
        'Resume execution; blocks until the debuggee stops, terminates, or the optional ' +
        'timeoutMs elapses. Timeout is NOT an error: the session stays alive and paused.',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'integer', default: 1 },
          timeoutMs: {
            type: 'integer',
            description: 'Override the bounded resume wait (default 30000)',
          },
        },
        additionalProperties: false,
      },
      handler: async (_ctx, args) => {
        const threadId = typeof args.threadId === 'number' ? args.threadId : 1;
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
        return session.continue(threadId, timeoutMs);
      },
    },
    {
      name: 'cql_debug_next',
      description: 'Step over the current statement. Same blocked-until-stop semantics as continue.',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'integer', default: 1 },
          timeoutMs: { type: 'integer' },
        },
        additionalProperties: false,
      },
      handler: async (_ctx, args) => {
        const threadId = typeof args.threadId === 'number' ? args.threadId : 1;
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
        return session.next(threadId, timeoutMs);
      },
    },
    {
      name: 'cql_debug_step_in',
      description: 'Step into the current call. Same blocked-until-stop semantics as continue.',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'integer', default: 1 },
          timeoutMs: { type: 'integer' },
        },
        additionalProperties: false,
      },
      handler: async (_ctx, args) => {
        const threadId = typeof args.threadId === 'number' ? args.threadId : 1;
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
        return session.stepIn(threadId, timeoutMs);
      },
    },
    {
      name: 'cql_debug_step_out',
      description: 'Step out of the current function. Same blocked-until-stop semantics as continue.',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'integer', default: 1 },
          timeoutMs: { type: 'integer' },
        },
        additionalProperties: false,
      },
      handler: async (_ctx, args) => {
        const threadId = typeof args.threadId === 'number' ? args.threadId : 1;
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
        return session.stepOut(threadId, timeoutMs);
      },
    },
    {
      name: 'cql_debug_get_variables',
      description:
        'Fetch variables. If frameId is given, scopes are enumerated and each scope is expanded ' +
        'into its variable list (flattened one level). If variablesReference is given, only that ' +
        "subtree is fetched. Exactly one of frameId / variablesReference should be supplied.",
      inputSchema: {
        type: 'object',
        properties: {
          frameId: { type: 'integer' },
          variablesReference: { type: 'integer' },
        },
        additionalProperties: false,
      },
      handler: async (_ctx, args) => {
        if (typeof args.variablesReference === 'number') {
          const variables = await session.getVariables(args.variablesReference);
          return { variables };
        }
        if (typeof args.frameId === 'number') {
          const scopes = await session.scopes(args.frameId);
          const enrichedScopes = [];
          for (const s of scopes) {
            const variables = await session.getVariables(s.variablesReference);
            enrichedScopes.push({ ...s, variables });
          }
          return { scopes: enrichedScopes };
        }
        throw new Error('Provide either frameId or variablesReference');
      },
    },
    {
      name: 'cql_debug_evaluate',
      description:
        'Evaluate a CQL expression in the current frame (frameId) or in a watch/hover context ' +
        '(no frameId). Returns the same shape DAP `evaluate` returns: result, type, variablesReference.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: { type: 'string' },
          frameId: { type: 'integer' },
        },
        required: ['expression'],
        additionalProperties: false,
      },
      handler: async (_ctx, args) => {
        if (missing(args, 'expression')) throw new Error(missing(args, 'expression')!);
        const frameId = typeof args.frameId === 'number' ? args.frameId : undefined;
        return session.evaluate(String(args.expression), frameId);
      },
    },
    {
      name: 'cql_debug_stop',
      description: 'Disconnect the active DAP session and close the TCP socket.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        await session.stop();
        return { active: false };
      },
    },
  ];
}
