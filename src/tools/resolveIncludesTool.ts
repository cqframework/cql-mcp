import * as fs from 'node:fs';
import * as path from 'node:path';
import { VIEW_ELM } from '../lsp/lspCommands.js';
import { openCqlFile } from './executeCqlTool.js';
import { missing } from './defs.js';
import type { Tool, McpContext } from './defs.js';
import { pathToUri } from '../workspace/paths.js';
import { extractSignatures, ExtractedSignatures } from './extractSignatures.js';
import { resolveIncludePath } from './includeResolver.js';

export const resolveIncludesTool: Tool = {
  name: 'cql_resolve_includes',
  description:
    'Resolves included CQL libraries referenced by a CQL file, locating their source files on disk and extracting their public definitions, functions, and terminology bindings.',
  inputSchema: {
    type: 'object',
    properties: {
      cqlFile: {
        type: 'string',
        description: 'Path to the primary .cql file',
      },
      alias: {
        type: 'string',
        description:
          'Optional alias (localIdentifier) to resolve specifically (e.g. "Global" or "FHIRHelpers"). If omitted, all included libraries are resolved.',
      },
      includeSignatures: {
        type: 'boolean',
        description:
          'Whether to parse and return public defines, functions, and value sets for each included library. Defaults to true.',
        default: true,
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

    const requestedAlias = args.alias as string | undefined;
    const includeSignatures = (args.includeSignatures as boolean | undefined) ?? true;

    await ctx.process.ensureReady();
    const client = ctx.process.lspClient;

    openCqlFile(client, cqlFile);

    // 1. Fetch ELM of the primary file
    const rootElmJson = (await ctx.process.executeCommand(VIEW_ELM, [
      pathToUri(cqlFile),
      'json',
    ])) as string;

    const rootSignatures = extractSignatures(rootElmJson);
    const targetIncludes = requestedAlias
      ? rootSignatures.includes.filter((inc) => inc.localIdentifier === requestedAlias)
      : rootSignatures.includes;

    if (requestedAlias && targetIncludes.length === 0) {
      throw new Error(`Include alias '${requestedAlias}' not found in ${path.basename(cqlFile)}`);
    }

    // 2. Resolve each dependency sequentially to avoid overloading the LS single-threaded compiler
    const workspaceFolders = [ctx.workspaceRoot];
    const results = [];

    for (const inc of targetIncludes) {
      const resolvedPath = resolveIncludePath({
        primaryFile: cqlFile,
        libraryName: inc.path,
        version: inc.version,
        workspaceFolders,
      });

      let signatures: Omit<ExtractedSignatures, 'includes'> | null = null;
      let note: string | undefined;

      if (resolvedPath && includeSignatures) {
        try {
          openCqlFile(client, resolvedPath);
          const depElm = (await ctx.process.executeCommand(VIEW_ELM, [
            pathToUri(resolvedPath),
            'json',
          ])) as string;

          const extracted = extractSignatures(depElm, { includePrivate: false });
          signatures = {
            library: extracted.library,
            parameters: extracted.parameters,
            defines: extracted.defines,
            functions: extracted.functions,
            valueSets: extracted.valueSets,
            codeSystems: extracted.codeSystems,
            codes: extracted.codes,
          };
        } catch (err) {
          note = `Failed to compile included library: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else if (!resolvedPath) {
        note = 'Library source file not located on disk (may be a built-in or system model library)';
      }

      results.push({
        alias: inc.localIdentifier,
        libraryName: inc.path,
        version: inc.version ?? null,
        resolvedPath,
        ...(signatures ? { signatures } : {}),
        ...(note ? { note } : {}),
      });
    }

    return {
      cqlFile,
      includes: results,
    };
  },
};
