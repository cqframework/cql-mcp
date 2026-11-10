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
import { ensureWorkspaceFolder, igRootOf, syncCqlDocument } from '../lsp/documentSync.js';
import { z } from 'zod';
import { cqlParametersSchema } from './schemas.js';
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

export interface ModelFs {
  existsSync(p: string): boolean;
  realpathSync(p: string): string;
}

/**
 * The data model for a directory of FHIR resources (for example a test-case folder), or null when
 * the directory is missing. Symlinks are resolved because the LS's IgStandardRepository walks the
 * directory with Files.walk, which does not follow them.
 */
export function modelFor(
  modelUri: string | undefined,
  modelName = 'FHIR',
  fsImpl: ModelFs = fs,
): { modelName: string; modelUri: string } | null {
  if (!modelUri || !fsImpl.existsSync(modelUri)) {
    return null;
  }
  return { modelName, modelUri: pathToUri(fsImpl.realpathSync(modelUri)) };
}

/**
 * Defaults for a file in an IG Publisher default layout (see igRootOf): the IG root, and the
 * default-layout locations of its value sets (input/vocabulary/valueset) and CQL options
 * (input/cql/cql-options.json). Empty when the file is not in such an IG.
 */
export function igDefaultsFor(cqlFile: string): Pick<CqlExecuteToolArgs, 'rootDir' | 'terminologyUri' | 'optionsPath'> {
  const root = igRootOf(cqlFile);
  if (!root) {
    return {};
  }
  return {
    rootDir: root,
    terminologyUri: path.join(root, 'input', 'vocabulary', 'valueset'),
    optionsPath: path.join(root, 'input', 'cql', 'cql-options.json'),
  };
}

/**
 * Mirrors buildRequest() from vscode-cql/src/cql-service/cqlService.executeCql.ts
 * but takes plain filesystem paths and only models a single library. rootDir, terminologyUri and
 * optionsPath default from the file's IG (igDefaultsFor); explicit arguments override them.
 */
export function buildExecuteCqlRequest(args: CqlExecuteToolArgs): ExecuteCqlRequest {
  const cqlFile = path.resolve(args.cqlFile);
  const libraryName = libraryNameOf(cqlFile);
  const libraryUri = pathToUri(path.dirname(cqlFile));
  const ig = igDefaultsFor(cqlFile);
  const rootDir = args.rootDir ?? ig.rootDir;
  const terminologyUri = args.terminologyUri ?? ig.terminologyUri;
  const optionsPath = args.optionsPath ?? ig.optionsPath;

  const parameters = (args.parameters ?? []).map((p) => ({
    parameterName: p.name,
    parameterType: p.type ?? '',
    parameterValue: p.value,
  }));

  const values = args.contextValues && args.contextValues.length > 0 ? args.contextValues : [undefined];

  const model = modelFor(args.modelUri, args.modelName);

  const libraries = values.map((contextValue) => ({
    libraryName,
    libraryUri,
    libraryVersion: args.libraryVersion ?? null,
    terminologyUri: existsElseNull(terminologyUri),
    model,
    context: contextValue ? { contextName: 'Patient', contextValue } : null,
    parameters,
  }));

  return {
    fhirVersion: args.fhirVersion ?? 'R4',
    rootDir: rootDir ? pathToUri(path.resolve(rootDir)) : null,
    optionsPath: existsElseNull(optionsPath),
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
    'Provide contextValues to run one library request per patient/context value. ' +
    'For a file in the IG Publisher default layout (<root>/input/cql/*.cql with an ig.ini at <root> or ' +
    'above), rootDir, terminologyUri and optionsPath default to <root> and the default-layout paths ' +
    '<root>/input/vocabulary/valueset and <root>/input/cql/cql-options.json; explicit arguments override. ' +
    'Other files get no rootDir. Patient data is only read when modelUri is set.',
  inputSchema: {
    cqlFile: z.string().min(1).describe('Path to the .cql file to execute'),
    fhirVersion: z.string().default('R4').describe('FHIR version, e.g. R4 (default R4)'),
    contextValues: z
      .array(z.string())
      .optional()
      .describe('Patient/context values; one library request is built per value'),
    parameters: cqlParametersSchema.optional(),
    terminologyUri: z
      .string()
      .optional()
      .describe('Path to a terminology directory/file. Defaults to <IG root>/input/vocabulary/valueset.'),
    optionsPath: z
      .string()
      .optional()
      .describe('Path to a cql-options file. Defaults to <IG root>/input/cql/cql-options.json.'),
    rootDir: z
      .string()
      .optional()
      .describe(
        'IG project root (where the LS finds ig.ini and loads IG packages). Defaults to the IG root of cqlFile; none outside an IG.',
      ),
    libraryVersion: z.string().optional(),
    modelUri: z
      .string()
      .optional()
      .describe(
        'Filesystem path to a directory of FHIR resources (IgStandardRepository root). ' +
          'When set, resources in that directory are loaded for retrieval; omit for compile-only runs.',
      ),
    modelName: z.string().default('FHIR').describe('Model identifier sent to the LS (defaults to "FHIR").'),
  },
  handler: async (_ctx, args) => {
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