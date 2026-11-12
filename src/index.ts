#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CqlLsProcess } from './jvm/cqlLsProcess.js';
import { RuntimeResolver } from './jvm/runtimeResolver.js';
import { DapSession } from './dap/dapSession.js';
import { log, configureLog } from './log.js';
import type { McpContext, Tool } from './tools/defs.js';
import { buildAllTools } from './tools/allTools.js';
import { createMcpServer } from './server.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';
import { resolveWorkspaceRoot } from './workspace/workspaceConfig.js';

const SHUTDOWN_WATCHDOG_MS = 15_000;

interface ServerHandles {
  process: CqlLsProcess;
  context: McpContext;
}

async function start(): Promise<void> {
  const logLevel = process.env.CQL_MCP_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined;
  configureLog({ level: logLevel, file: process.env.CQL_MCP_LOG_FILE });

  const workspaceRoot = resolveWorkspaceRoot();

  // Java and the jar are resolved lazily on first use (ADR-0001 §2.2), so a missing JDK or a slow
  // first-run download never blocks `initialize`.
  const runtime = new RuntimeResolver();
  const lsProcess = new CqlLsProcess({
    runtime,
    workspacePath: workspaceRoot,
    logFile: process.env.CQL_MCP_LOG_FILE,
  });

  const debugSession = new DapSession({ ls: lsProcess });

  const context: McpContext = {
    process: lsProcess,
    debugSession,
    runtime,
    workspaceRoot,
  };

  const tools: Tool[] = buildAllTools(debugSession);

  const server = createMcpServer(tools, context);

  const handles = { lsProcess, debugSession };

  // Runs once, whichever of the triggers below comes first. The watchdog bounds the whole
  // sequence (a DAP disconnect or LS shutdown that never answers), so node always exits.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}; shutting down`);
    setTimeout(() => {
      log.error(`Shutdown did not finish within ${SHUTDOWN_WATCHDOG_MS} ms; exiting`);
      process.exit(1);
    }, SHUTDOWN_WATCHDOG_MS).unref();
    void handles.debugSession
      .stop()
      .catch((err: unknown) => log.error('Error stopping DAP session', { message: err instanceof Error ? err.message : err }))
      .finally(() => {
        handles.lsProcess
          .stop()
          .catch((err: unknown) => log.error('Error during shutdown', { message: err instanceof Error ? err.message : err }))
          .finally(() => process.exit(0));
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  // MCP clients disconnect by closing stdin, but @modelcontextprotocol/sdk 1.30.0's
  // StdioServerTransport only listens for stdin 'data' and 'error' (dist/esm/server/stdio.js:37-38;
  // unchanged in 1.32.1), so without this the server and its LS JVM outlive the client.
  process.stdin.once('end', () => shutdown('stdin end'));
  process.stdin.once('close', () => shutdown('stdin close'));
  process.once('exit', () => {
    // Best-effort: kill the child if we are about to die unexpectedly.
    void handles.debugSession.stop();
    void handles.lsProcess.stop();
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`${SERVER_NAME} ${SERVER_VERSION} ready (workspace=${workspaceRoot}; Java and the language-server jar are resolved on first use)`);
}

start().catch((err) => {
  log.error('Fatal startup error', { message: err instanceof Error ? err.message : err });
  process.stderr.write(`cql-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});