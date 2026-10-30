import * as fs from 'node:fs';
import * as path from 'node:path';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { VIEW_ELM } from '../lsp/lspCommands.js';
import { ensureWorkspaceFolder, syncCqlDocument } from '../lsp/documentSync.js';
import { missing } from './defs.js';
import type { Tool, McpContext } from './defs.js';
import { pathToUri } from '../workspace/paths.js';

export interface FormattedDiagnostic {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  code?: string | number;
}

function mapSeverity(sev?: DiagnosticSeverity): 'error' | 'warning' | 'info' | 'hint' {
  switch (sev) {
    case DiagnosticSeverity.Error:
      return 'error';
    case DiagnosticSeverity.Warning:
      return 'warning';
    case DiagnosticSeverity.Information:
      return 'info';
    case DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return 'error';
  }
}

export const validateTool: Tool = {
  name: 'cql_validate',
  description:
    'Validates a CQL file or in-memory CQL content for syntax and type errors without executing patient bundles, returning compiler diagnostics and translation errors.',
  inputSchema: {
    type: 'object',
    properties: {
      cqlFile: {
        type: 'string',
        description: 'Path to the .cql file',
      },
      content: {
        type: 'string',
        description:
          'Optional in-memory CQL content to validate without saving to disk. Overrides file contents on disk.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Maximum milliseconds to wait for compiler diagnostics. Defaults to 2000.',
        default: 2000,
      },
      quiescenceMs: {
        type: 'number',
        description:
          'Milliseconds of quiet time after receiving diagnostics before settling. Defaults to 100.',
        default: 100,
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
    const inMemoryContent = args.content as string | undefined;

    if (inMemoryContent && inMemoryContent.length > 5 * 1024 * 1024) {
      throw new Error('content exceeds maximum size limit of 5MB');
    }

    if (!inMemoryContent && !fs.existsSync(cqlFile)) {
      throw new Error(`CQL file not found: ${cqlFile}`);
    }

    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 2000;
    const quiescenceMs = typeof args.quiescenceMs === 'number' ? args.quiescenceMs : 100;

    await ctx.process.ensureReady();
    const client = ctx.process.lspClient;

    ensureWorkspaceFolder(client, cqlFile);

    // 1. Sync document (with in-memory override if provided)
    syncCqlDocument(client, cqlFile, inMemoryContent);

    // 2. Start waiting for publishDiagnostics to arrive and settle
    const diagnosticsPromise = client.waitForDiagnostics(cqlFile, timeoutMs, quiescenceMs);

    // 3. Trigger compilation via VIEW_ELM as a concurrent verification
    let elmError: string | null = null;
    try {
      await ctx.process.executeCommand(VIEW_ELM, [pathToUri(cqlFile), 'json']);
    } catch (err) {
      elmError = err instanceof Error ? err.message : String(err);
    }

    // 4. Gather diagnostics
    const rawDiagnostics: Diagnostic[] = await diagnosticsPromise;

    const formatted: FormattedDiagnostic[] = rawDiagnostics.map((d) => {
      const msg = typeof d.message === 'string' ? d.message : (d.message as any)?.value ?? String(d.message);
      return {
        severity: mapSeverity(d.severity),
        message: msg,
        range: {
          start: { line: d.range.start.line + 1, character: d.range.start.character },
          end: { line: d.range.end.line + 1, character: d.range.end.character },
        },
        ...(d.code !== undefined ? { code: d.code } : {}),
      };
    });

    // If VIEW_ELM failed with an error not already captured in diagnostics, merge it
    if (elmError) {
      const alreadyReported = formatted.some((f) => f.message.includes(elmError!) || elmError!.includes(f.message));
      if (!alreadyReported) {
        formatted.push({
          severity: 'error',
          message: elmError,
          code: 'MERGED_FROM_VIEW_ELM',
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 0 },
          },
        });
      }
    }

    const errorCount = formatted.filter((d) => d.severity === 'error').length;
    const warningCount = formatted.filter((d) => d.severity === 'warning').length;

    return {
      cqlFile,
      valid: errorCount === 0,
      errorCount,
      warningCount,
      diagnostics: formatted,
    };
  },
};
