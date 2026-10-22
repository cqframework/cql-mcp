import * as fs from 'node:fs';
import * as path from 'node:path';
import { VIEW_ELM } from '../lsp/lspCommands.js';
import { openCqlFile } from './executeCqlTool.js';
import { missing } from './defs.js';
import type { Tool } from './defs.js';
import { pathToUri } from '../workspace/paths.js';

export interface CqlViewElmInput {
  cqlFile: string;
  elmType: 'xml' | 'json' | 'ast';
}

export const viewElmTool: Tool = {
  name: 'cql_view_elm',
  description:
    "Return the ELM representation of a CQL library as the language server serializes it. elmType is 'xml', 'json', or 'ast'.",
  inputSchema: {
    type: 'object',
    properties: {
      cqlFile: { type: 'string', description: 'Path to the .cql file' },
      elmType: {
        type: 'string',
        enum: ['xml', 'json', 'ast'],
        default: 'xml',
      },
    },
    required: ['cqlFile'],
    additionalProperties: false,
  },
  handler: async (ctx, args) => {
    const missingFile = missing(args, 'cqlFile');
    if (missingFile) {
      throw new Error(missingFile);
    }
    const cqlFile = path.resolve(args.cqlFile as string);
    if (!fs.existsSync(cqlFile)) {
      throw new Error(`CQL file not found: ${cqlFile}`);
    }
    const elmTypeRaw = (args.elmType as string) ?? 'xml';
    if (elmTypeRaw !== 'xml' && elmTypeRaw !== 'json' && elmTypeRaw !== 'ast') {
      throw new Error(`elmType must be 'xml', 'json', or 'ast'; got '${elmTypeRaw}'`);
    }

    await ctx.process.ensureReady();
    const client = ctx.process.lspClient;
    openCqlFile(client, cqlFile);
    const content = (await ctx.process.executeCommand(VIEW_ELM, [
      pathToUri(cqlFile),
      elmTypeRaw,
    ])) as string;
    return {
      cqlFile,
      elmType: elmTypeRaw,
      content,
    };
  },
};