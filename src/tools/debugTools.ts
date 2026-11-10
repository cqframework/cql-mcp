import type { DapSession, DebugLaunchArgs, StepGranularity } from '../dap/dapSession.js';
import { GET_VERSION_INFO } from '../lsp/lspCommands.js';
import { z } from 'zod';
import { cqlParameterSchema } from './schemas.js';
import { buildWithin, fitPrefix, jsonLength, maxCharsOf, maxCharsSchema, MAX_LISTED_OMISSIONS } from './outputLimit.js';
import type { McpContext, Tool } from './defs.js';
import { STATEFUL } from './annotations.js';

/**
 * Warning for language servers released before the DebugSession socket-close fix
 * (cql-language-server bf40a031, 2026-09-17; first released in 5.0.0). Without
 * it a request made after a session has ended hangs. Null for newer or unparseable versions.
 */
export function debugVersionWarning(version: string | null | undefined): string | null {
  const m = /^(\d+)\.(\d+)\./.exec(version ?? '');
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major > 4 || (major === 4 && minor >= 11)) return null;
  return (
    `LS ${version} predates the DebugSession socket-close fix (cql-language-server bf40a031, ` +
    '2026-09-17); set CQL_LS_JAR_PATH to a current build for debugging'
  );
}

async function languageServerVersion(ctx: McpContext): Promise<string | null> {
  try {
    const info = (await ctx.process.executeCommand(GET_VERSION_INFO, [])) as { languageServer?: string };
    return info.languageServer ?? null;
  } catch {
    return null; // best effort: the version only drives a warning
  }
}

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

/**
 * `cql_debug_start.parameters` accepts the documented `[{ name, type, value }]` form (as the other
 * tools take) and the older `{ name: value }` object; both become the `{ name: value }` object the
 * DAP launch request carries (ADR-0004 §2.2).
 */
export function normalizeParameters(raw: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(raw)) {
    const out: Record<string, unknown> = {};
    for (const p of raw as Array<{ name: string; value: unknown }>) {
      out[p.name] = p.value;
    }
    return out;
  }
  if (raw && typeof raw === 'object') {
    return raw as Record<string, unknown>;
  }
  return undefined;
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
  const parameters = normalizeParameters(args.parameters);
  if (parameters) out.parameters = parameters;
  if (Array.isArray(args.breakpoints)) {
    out.breakpoints = args.breakpoints.filter(
      (n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0,
    );
  }
  return out;
}

interface NamedVariable {
  name?: string;
}

/**
 * Bound a variables result to about `maxChars` (ADR-0004 §2.4): trailing variables are dropped
 * (across scopes, in order) and listed by name; the scope headers are always kept.
 */
export function boundVariables<T extends { variables: NamedVariable[] } | { scopes: Array<{ variables: NamedVariable[] }> }>(
  result: T,
  maxChars: number,
): T | (T & { truncated: true; totalChars: number; maxChars: number; omittedCount: number; omittedVariables: string[] }) {
  const totalChars = jsonLength(result);
  if (totalChars <= maxChars) {
    return result;
  }
  const groups: NamedVariable[][] = 'variables' in result ? [result.variables] : result.scopes.map((s) => s.variables);
  const skeleton = 'variables' in result
    ? { ...result, variables: [] }
    : { ...result, scopes: result.scopes.map((s) => ({ ...s, variables: [] })) };
  const skeletonLength = jsonLength(skeleton);
  return buildWithin(maxChars, 300, (rawBudget) => {
    let budget = rawBudget - skeletonLength;
    const keptGroups: NamedVariable[][] = [];
    const omitted: NamedVariable[] = [];
    for (const group of groups) {
      const { kept, omitted: dropped } = fitPrefix(group, budget);
      budget -= kept.reduce((n, v) => n + jsonLength(v) + 1, 0);
      // After the first drop nothing later is kept, so the output is a clean prefix.
      if (dropped.length > 0) budget = 0;
      keptGroups.push(kept);
      omitted.push(...dropped);
    }
    const bounded =
      'variables' in result
        ? { ...result, variables: keptGroups[0] }
        : { ...result, scopes: result.scopes.map((s, i) => ({ ...s, variables: keptGroups[i] })) };
    return {
      ...(bounded as T),
      truncated: true as const,
      totalChars,
      maxChars,
      omittedCount: omitted.length,
      omittedVariables: omitted.slice(0, MAX_LISTED_OMISSIONS).map((v) => v.name ?? '?'),
    };
  });
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
        'a .cql file (the tool internally computes both DAP-form and executeCql-form URIs). For a file in the ' +
        'IG Publisher default layout (<root>/input/cql/*.cql with an ig.ini at <root> or above), rootDir, ' +
        'terminologyUri and optionsPath default to <root> and the default-layout paths ' +
        '<root>/input/vocabulary/valueset and <root>/input/cql/cql-options.json (when they exist), as for ' +
        'cql_execute; explicit arguments override. Without rootDir an IG library fails to compile and the ' +
        'session terminates without stopping.',
      annotations: STATEFUL,
      inputSchema: {
        cqlFile: z.string().min(1).describe('Absolute path to the .cql file'),
        fhirVersion: z.string().optional().describe('FHIR version (default R4)'),
        testCaseName: z.string().optional().describe('MADIE bundle name to run'),
        testCaseDir: z.string().optional().describe('Path to MADIE test-case bundle directory'),
        terminologyUri: z.string().optional(),
        rootDir: z.string().optional(),
        optionsPath: z.string().optional(),
        stepGranularity: z
          .enum(['ast', 'cql'])
          .optional()
          .describe('AST-level stepping when "ast", CQL-line-level otherwise (default "cql")'),
        parameters: z
          .union([z.array(cqlParameterSchema), z.record(z.string(), z.unknown())])
          .optional()
          .describe(
            'CQL parameter values: an array of { name, type, value } (preferred, as for cql_execute), or an object keyed by name',
          ),
        breakpoints: z
          .array(z.number().int())
          .optional()
          .describe('1-indexed line numbers to set on cqlFile before launch'),
      },
      handler: async (ctx, args) => {
        const launchArgs = extractLaunchArgs(args);
        await session.start(launchArgs);
        const warning = debugVersionWarning(await languageServerVersion(ctx));
        return warning ? { active: true, warning } : { active: true };
      },
    },
    {
      name: 'cql_debug_set_breakpoints',
      description:
        'Set breakpoints (line numbers) in a CQL file. Put each breakpoint on an expression line, not on the ' +
        '`define "X":` line: the LS only stops on expression and expression-term start lines ' +
        '(CqlStepPositionCollector.collectBreakpointableLines). The response may still say verified=true for ' +
        'other lines; the LS marks them unverified later (BreakpointManager.updateBreakpointLineVerification), ' +
        'and a resume that then terminates without stopping lists them in unverifiedBreakpoints.',
      annotations: STATEFUL,
      inputSchema: {
        cqlFile: z.string().min(1).describe('Absolute path to the .cql file'),
        lines: z.array(z.number().int().positive()).min(1).describe('1-indexed line numbers'),
      },
      handler: async (_ctx, args) => {
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
        'timeoutMs elapses. Timeout is NOT an error: the session stays alive and paused. ' +
        'When the debuggee terminates (or the language server goes away) the session ends by itself, ' +
        'so cql_debug_start can be called again without cql_debug_stop. If it terminates without ever ' +
        'stopping although breakpoints were set, the result has a note, unverifiedBreakpoints, and errors ' +
        '(Error entries from re-running the library with the launch settings); with no breakpoints set the ' +
        'note is "terminated (no breakpoints set)".',
      annotations: STATEFUL,
      inputSchema: {
        threadId: z.number().int().default(1),
        timeoutMs: z.number().int().optional().describe('Override the bounded resume wait (default 30000)'),
      },
      handler: async (_ctx, args) => {
        const threadId = typeof args.threadId === 'number' ? args.threadId : 1;
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
        return session.continue(threadId, timeoutMs);
      },
    },
    {
      name: 'cql_debug_next',
      description: 'Step over the current statement. Same blocked-until-stop semantics, and same terminated result, as continue.',
      annotations: STATEFUL,
      inputSchema: {
        threadId: z.number().int().default(1),
        timeoutMs: z.number().int().optional(),
      },
      handler: async (_ctx, args) => {
        const threadId = typeof args.threadId === 'number' ? args.threadId : 1;
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
        return session.next(threadId, timeoutMs);
      },
    },
    {
      name: 'cql_debug_step_in',
      description: 'Step into the current call. Same blocked-until-stop semantics, and same terminated result, as continue.',
      annotations: STATEFUL,
      inputSchema: {
        threadId: z.number().int().default(1),
        timeoutMs: z.number().int().optional(),
      },
      handler: async (_ctx, args) => {
        const threadId = typeof args.threadId === 'number' ? args.threadId : 1;
        const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
        return session.stepIn(threadId, timeoutMs);
      },
    },
    {
      name: 'cql_debug_step_out',
      description: 'Step out of the current function. Same blocked-until-stop semantics, and same terminated result, as continue.',
      annotations: STATEFUL,
      inputSchema: {
        threadId: z.number().int().default(1),
        timeoutMs: z.number().int().optional(),
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
        "subtree is fetched. Exactly one of frameId / variablesReference should be supplied. " +
        'Output is bounded by maxChars: when there are more variables than fit, trailing variables are dropped and ' +
        'listed by name under omittedVariables (with omittedCount), and the result has truncated: true, totalChars ' +
        '(the full serialized length) and maxChars. Fetch a sub-tree with variablesReference or raise maxChars to see the rest.',
      annotations: STATEFUL,
      inputSchema: {
        frameId: z.number().int().optional(),
        variablesReference: z.number().int().optional(),
        maxChars: maxCharsSchema,
      },
      handler: async (_ctx, args) => {
        const maxChars = maxCharsOf(args);
        if (typeof args.variablesReference === 'number') {
          const variables = await session.getVariables(args.variablesReference);
          return boundVariables({ variables }, maxChars);
        }
        if (typeof args.frameId === 'number') {
          const scopes = await session.scopes(args.frameId);
          const enrichedScopes = [];
          for (const s of scopes) {
            const variables = await session.getVariables(s.variablesReference);
            enrichedScopes.push({ ...s, variables });
          }
          return boundVariables({ scopes: enrichedScopes }, maxChars);
        }
        throw new Error('Provide either frameId or variablesReference');
      },
    },
    {
      name: 'cql_debug_evaluate',
      description:
        'Evaluate a CQL expression in the current frame (frameId) or in a watch/hover context ' +
        '(no frameId). Returns the same shape DAP `evaluate` returns: result, type, variablesReference.',
      annotations: STATEFUL,
      inputSchema: {
        expression: z.string().min(1),
        frameId: z.number().int().optional(),
      },
      handler: async (_ctx, args) => {
        const frameId = typeof args.frameId === 'number' ? args.frameId : undefined;
        return session.evaluate(String(args.expression), frameId);
      },
    },
    {
      name: 'cql_debug_stop',
      description:
        'Disconnect the active DAP session and close the TCP socket. A no-op if the session has ' +
        'already ended (the debuggee terminated or the language server went away).',
      annotations: STATEFUL,
      inputSchema: {},
      handler: async () => {
        await session.stop();
        return { active: false };
      },
    },
  ];
}
