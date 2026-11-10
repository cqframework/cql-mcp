import { GET_VERSION_INFO } from '../lsp/lspCommands.js';
import type { Tool } from './defs.js';
import { READ_ONLY } from './annotations.js';

export const getStatusTool: Tool = {
  name: 'cql_get_status',
  description:
    'Report JVM/Language Server readiness, jar path and source, java version, workspace root, and the language server version string. The first call starts resolving Java and the language-server jar in the background (a first run may download the jar); until it is ready, `runtime.state` is `resolving` with the current `phase` and download progress.',
  annotations: READ_ONLY,
  inputSchema: {},
  handler: async (ctx) => {
    // Starting resolution does not block; the status below reports its progress.
    ctx.runtime.start();
    const runtime = ctx.runtime.status();
    let languageServerVersion: string | null = null;
    if (runtime.state === 'ready') {
      try {
        await ctx.process.ensureReady();
        const vi = (await ctx.process.executeCommand(GET_VERSION_INFO, [])) as {
          languageServer?: string;
        };
        languageServerVersion = vi.languageServer ?? null;
      } catch {
        // Non-fatal: the JAR filename already carries the version.
      }
    }
    return {
      ready: ctx.process.currentState === 'ready',
      state: ctx.process.currentState,
      runtime: {
        state: runtime.state,
        phase: runtime.phase ?? null,
        download: runtime.download ?? null,
        error: runtime.error ?? null,
        retryAt: runtime.retryAt ?? null,
      },
      jarPath: runtime.jarPath ?? null,
      jarSource: runtime.jarSource ?? null,
      javaVersion: runtime.javaVersion ?? null,
      workspaceRoot: ctx.workspaceRoot,
      languageServerVersion,
      activeDebugSession: ctx.debugSession.isActive,
    };
  },
};