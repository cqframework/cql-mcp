import { GET_VERSION_INFO } from '../lsp/lspCommands.js';
import type { Tool } from './defs.js';

export const getStatusTool: Tool = {
  name: 'cql_get_status',
  description:
    'Report JVM/Language Server readiness, jar path, java version, workspace root, and the language server version string.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async (ctx) => {
    let languageServerVersion: string | null = null;
    try {
      await ctx.process.ensureReady();
      const vi = (await ctx.process.executeCommand(GET_VERSION_INFO, [])) as {
        languageServer?: string;
      };
      languageServerVersion = vi.languageServer ?? null;
    } catch {
      // Non-fatal: the JAR filename already carries the version.
    }
    return {
      ready: ctx.process.currentState === 'ready',
      state: ctx.process.currentState,
      jarPath: ctx.jarPath,
      javaVersion: ctx.javaVersion,
      workspaceRoot: ctx.workspaceRoot,
      languageServerVersion,
      activeDebugSession: ctx.debugSession.isActive,
    };
  },
};