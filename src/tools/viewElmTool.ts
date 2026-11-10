import * as fs from 'node:fs';
import * as path from 'node:path';
import { VIEW_ELM } from '../lsp/lspCommands.js';
import { openCqlFile } from './executeCqlTool.js';
import { z } from 'zod';
import { buildWithin, jsonLength, maxCharsOf, maxCharsSchema } from './outputLimit.js';
import type { Tool } from './defs.js';
import { pathToUri } from '../workspace/paths.js';
import { READ_ONLY } from './annotations.js';

export interface CqlViewElmInput {
  cqlFile: string;
  elmType: 'xml' | 'json' | 'ast';
}

export interface ViewElmResult {
  cqlFile: string;
  elmType: string;
  content: string;
}

/**
 * Bound the serialized result to `maxChars` (ADR-0004 §2.4). Over the limit, `content` is cut to the
 * longest prefix for which `JSON.stringify(result).length <= maxChars` (escaped quotes and newlines
 * count), and the result is marked truncated with `totalChars`, the full serialized length.
 */
export function boundViewElmResult(
  result: ViewElmResult,
  maxChars: number,
): ViewElmResult | (ViewElmResult & { truncated: true; totalChars: number; maxChars: number }) {
  const totalChars = jsonLength(result);
  if (totalChars <= maxChars) {
    return result;
  }
  return buildWithin(maxChars, 0, (budget) => {
    const header = { cqlFile: result.cqlFile, elmType: result.elmType, truncated: true as const, totalChars, maxChars };
    // The longest prefix whose escaped form fits next to the header (binary search: escaping is not linear).
    const room = budget - jsonLength({ ...header, content: '' });
    let lo = 0;
    let hi = Math.min(result.content.length, Math.max(0, room));
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      // jsonLength includes the two quotes already counted in `header` (content: '').
      if (jsonLength(result.content.slice(0, mid)) - 2 <= room) lo = mid;
      else hi = mid - 1;
    }
    return { ...header, content: result.content.slice(0, lo) };
  });
}

export const viewElmTool: Tool = {
  name: 'cql_view_elm',
  description:
    "Return the ELM representation of a CQL library as the language server serializes it. elmType is 'xml', 'json', or 'ast'. " +
    'Output is bounded by maxChars, measured on the serialized JSON result (quotes in JSON ELM are escaped, so they count twice): ' +
    'when the result is longer, `content` is cut to a prefix that makes the whole result fit, and the result has ' +
    'truncated: true, totalChars (the full serialized length) and maxChars. Use a larger maxChars to see more.',
  annotations: READ_ONLY,
  inputSchema: {
    cqlFile: z.string().min(1).describe('Path to the .cql file'),
    elmType: z.enum(['xml', 'json', 'ast']).default('xml'),
    maxChars: maxCharsSchema,
  },
  handler: async (ctx, args) => {
    const cqlFile = path.resolve(args.cqlFile as string);
    if (!fs.existsSync(cqlFile)) {
      throw new Error(`CQL file not found: ${cqlFile}`);
    }
    const elmTypeRaw = (args.elmType as string) ?? 'xml';

    await ctx.process.ensureReady();
    const client = ctx.process.lspClient;
    openCqlFile(client, cqlFile);
    const content = (await ctx.process.executeCommand(VIEW_ELM, [
      pathToUri(cqlFile),
      elmTypeRaw,
    ])) as string;
    return boundViewElmResult({ cqlFile, elmType: elmTypeRaw, content }, maxCharsOf(args));
  },
};