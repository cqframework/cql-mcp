import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXECUTE_CQL } from '../lsp/lspCommands.js';
import type { LspClient } from '../lsp/lspClient.js';
import type {
  ExecuteCqlRequest,
  ExecuteCqlResponse,
  LibraryResult,
} from '../lsp/protocol.js';
import { libraryNameOf, pathToUri } from '../workspace/paths.js';
import { ensureWorkspaceFolder, syncCqlDocument } from '../lsp/documentSync.js';
import { missing, expectString } from './defs.js';
import type { Tool } from './defs.js';

export interface CqlExecuteToolArgs {
  cqlFile: string;
  fhirVersion?: string;
  contextValues?: string[];
  parameters?: Array<{ name: string; type?: string; value: string }>;
  terminologyUri?: string;
  optionsPath?: string;
  rootDir?: string;
  libraryVersion?: string | null;
  modelUri?: string;
  modelName?: string;
}

export function existsElseNull(p: string | undefined): string | null {
  if (!p) {
    return null;
  }
  return fs.existsSync(p) ? pathToUri(path.resolve(p)) : null;
}

/**
 * Mirrors buildRequest() from vscode-cql/src/cql-service/cqlService.executeCql.ts
 * but takes plain filesystem paths and only models a single library.
 */
export function buildExecuteCqlRequest(args: CqlExecuteToolArgs): ExecuteCqlRequest {
  const cqlFile = path.resolve(args.cqlFile);
  const libraryName = libraryNameOf(cqlFile);
  const libraryUri = pathToUri(path.dirname(cqlFile));

  const parameters = (args.parameters ?? []).map((p) => ({
    parameterName: p.name,
    parameterType: p.type ?? '',
    parameterValue: p.value,
  }));

  const values = args.contextValues && args.contextValues.length > 0 ? args.contextValues : [undefined];

  const model =
    args.modelUri && fs.existsSync(args.modelUri)
      ? {
          modelName: args.modelName ?? 'FHIR',
          modelUri: pathToUri(fs.realpathSync(args.modelUri)),
        }
      : null;

  const libraries = values.map((contextValue) => ({
    libraryName,
    libraryUri,
    libraryVersion: args.libraryVersion ?? null,
    terminologyUri: existsElseNull(args.terminologyUri),
    model,
    context: contextValue ? { contextName: 'Patient', contextValue } : null,
    parameters,
  }));

  return {
    fhirVersion: args.fhirVersion ?? 'R4',
    rootDir: args.rootDir ? pathToUri(path.resolve(args.rootDir)) : null,
    optionsPath: existsElseNull(args.optionsPath),
    libraries,
  };
}

export interface CqlExecuteResult {
  success: boolean;
  results: LibraryResult[];
  diagnostics: Array<{ name: string; value: string }>;
  logs: string[];
  versions?: ExecuteCqlResponse['versions'];
}

function toResult(response: ExecuteCqlResponse): CqlExecuteResult {
  const diagnostics: Array<{ name: string; value: string }> = [];
  for (const result of response.results) {
    for (const expr of result.expressions) {
      if (expr.name === 'Error') {
        diagnostics.push({ name: expr.name, value: expr.value });
      }
    }
  }
  return {
    success: diagnostics.length === 0,
    results: response.results,
    diagnostics,
    logs: response.logs,
    versions: response.versions,
  };
}

/**
 * Make the file visible to the language server with its current text: adds its project folder as
 * a workspace folder if no known folder contains it, then sends didOpen the first time and
 * didChange (which invalidates the server's compile cache) when the text has changed since.
 * See ../lsp/documentSync.ts.
 */
export function openCqlFile(client: LspClient, cqlFile: string): void {
  ensureWorkspaceFolder(client, cqlFile);
  syncCqlDocument(client, cqlFile);
}

export const executeCqlTool: Tool = {
  name: 'cql_execute',
  description:
    'Execute a single CQL library against the language server and return expression results. ' +
    'Compiler/runtime errors are returned as diagnostics with success=false (not a transport error). ' +
    'Provide contextValues to run one library request per patient/context value.',
  inputSchema: {
    type: 'object',
    properties: {
      cqlFile: { type: 'string', description: 'Path to the .cql file to execute' },
      fhirVersion: {
        type: 'string',
        description: 'FHIR version, e.g. R4 (default R4)',
        default: 'R4',
      },
      contextValues: {
        type: 'array',
        items: { type: 'string' },
        description: 'Patient/context values; one library request is built per value',
      },
      parameters: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['name', 'value'],
        },
      },
      terminologyUri: { type: 'string', description: 'Path to a terminology directory/file' },
      optionsPath: { type: 'string', description: 'Path to a cql-options file' },
      rootDir: { type: 'string', description: 'Project root directory' },
      libraryVersion: { type: 'string' },
      modelUri: {
        type: 'string',
        description:
          'Filesystem path to a directory of FHIR resources (IgStandardRepository root). ' +
          'When set, resources in that directory are loaded for retrieval; omit for compile-only runs.',
      },
      modelName: {
        type: 'string',
        description: 'Model identifier sent to the LS (defaults to "FHIR").',
        default: 'FHIR',
      },
    },
    required: ['cqlFile'],
    additionalProperties: false,
  },
  handler: async (_ctx, args) => {
    const missingFile = missing(args, 'cqlFile');
    if (missingFile) {
      throw new Error(missingFile);
    }
    const typeError =
      expectString(args, 'cqlFile') ??
      expectString(args, 'fhirVersion') ??
      expectString(args, 'terminologyUri') ??
      expectString(args, 'optionsPath') ??
      expectString(args, 'rootDir') ??
      expectString(args, 'modelUri') ??
      expectString(args, 'modelName');
    if (typeError) {
      throw new Error(typeError);
    }

    const cqlFile = path.resolve(args.cqlFile as string);
    if (!fs.existsSync(cqlFile)) {
      throw new Error(`CQL file not found: ${cqlFile}`);
    }

    const toolArgs = args as unknown as CqlExecuteToolArgs;
    const request = buildExecuteCqlRequest(toolArgs);
    // Ensure the LS is up; respawns transparently after a crash.
    await _ctx.process.ensureReady();
    const client = _ctx.process.lspClient;
    // The LS's FederatedLibrarySourceProvider resolves the CQL source through
    // ActiveContentService, which only sees documents we explicitly didOpen.
    // Mirror the editor behavior the VS Code extension provides for free.
    openCqlFile(client, cqlFile);
    // executeCommand on the process wraps crashes into LanguageServerCrashedError
    // and respawns automatically on the next call, unlike a raw client send.
    const raw = await _ctx.process.executeCommand(EXECUTE_CQL, [request]);
    return toResult(raw as ExecuteCqlResponse);
  },
};