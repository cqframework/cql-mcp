import * as fs from 'node:fs';
import * as path from 'node:path';
import { VIEW_ELM } from '../lsp/lspCommands.js';
import { openCqlFile } from './executeCqlTool.js';
import { missing } from './defs.js';
import type { Tool, McpContext } from './defs.js';
import { pathToUri } from '../workspace/paths.js';
import { extractSignatures } from './extractSignatures.js';

export const signaturesTool: Tool = {
  name: 'cql_get_signatures',
  description:
    'Extracts all expressions (defines), functions, parameters, value sets, and code systems from a CQL file along with their exact compiled return types and parameter types.',
  inputSchema: {
    type: 'object',
    properties: {
      cqlFile: {
        type: 'string',
        description: 'Path to the .cql file',
      },
      includePrivate: {
        type: 'boolean',
        description: 'Whether to include private definitions and functions. Defaults to false.',
        default: false,
      },
    },
    required: ['cqlFile'],
    additionalProperties: false,
  },
  handler: async (ctx: McpContext, args: Record<string, unknown>) => {
    const missingFile = missing(args, 'cqlFile');
    if (missingFile) {
      throw new Error(missingFile);
    }
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
