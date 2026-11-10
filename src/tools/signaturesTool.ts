import * as fs from 'node:fs';
import * as path from 'node:path';
import { VIEW_ELM } from '../lsp/lspCommands.js';
import { openCqlFile } from './executeCqlTool.js';
import { z } from 'zod';
import type { Tool, McpContext } from './defs.js';
import { pathToUri } from '../workspace/paths.js';
import { extractSignatures } from './extractSignatures.js';

export const signaturesTool: Tool = {
  name: 'cql_get_signatures',
  description:
    'Extracts all expressions (defines), functions, parameters, value sets, and code systems from a CQL file along with their exact compiled return types and parameter types.',
  inputSchema: {
    cqlFile: z.string().min(1).describe('Path to the .cql file'),
    includePrivate: z
      .boolean()
      .default(false)
      .describe('Whether to include private definitions and functions. Defaults to false.'),
  },
  handler: async (ctx: McpContext, args: Record<string, unknown>) => {
    const cqlFile = path.resolve(args.cqlFile as string);
    if (!fs.existsSync(cqlFile)) {
      throw new Error(`CQL file not found: ${cqlFile}`);
    }

    const includePrivate = Boolean(args.includePrivate ?? false);

    await ctx.process.ensureReady();
    const client = ctx.process.lspClient;

    openCqlFile(client, cqlFile);

    const elmJson = (await ctx.process.executeCommand(VIEW_ELM, [
      pathToUri(cqlFile),
      'json',
    ])) as string;

    const signatures = extractSignatures(elmJson, { includePrivate });

    return {
      cqlFile,
      ...signatures,
    };
  },
};
