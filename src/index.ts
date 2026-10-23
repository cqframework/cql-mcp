#!/usr/bin/env node
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CqlLsProcess, LanguageServerCrashedError } from './jvm/cqlLsProcess.js';
import { ensureJar, JarInstallError } from './jvm/jarInstaller.js';
import { findJavaRuntime } from './jvm/javaLocator.js';
import { DapSession } from './dap/dapSession.js';
import { log, configureLog } from './log.js';
import type { McpContext, Tool } from './tools/defs.js';
import { executeCqlTool } from './tools/executeCqlTool.js';
import { getStatusTool } from './tools/statusTool.js';
import { viewElmTool } from './tools/viewElmTool.js';
import { buildDebugTools } from './tools/debugTools.js';
import { buildTestPipelineTools } from './tools/testPipelineTools.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';
import { resolveWorkspaceRoot } from './workspace/workspaceConfig.js';

const SHUTDOWN_WATCHDOG_MS = 15_000;

interface ServerHandles {
  process: CqlLsProcess;
  context: McpContext;
}

function requireTool(tools: Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
  return tool;
}

async function start(): Promise<void> {
  const logLevel = process.env.CQL_DEBUG_MCP_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined;
  configureLog({ level: logLevel, file: process.env.CQL_DEBUG_MCP_LOG_FILE });

  const workspaceRoot = resolveWorkspaceRoot();

  let java;
  try {
    java = findJavaRuntime();
  } catch (err) {
    log.warn('Java detection errored', { message: err instanceof Error ? err.message : String(err) });
  }
  if (!java) {
    throw new Error(
      `No Java >= 17 found. Set JAVA_HOME or add java to PATH. Detected candidates: ${[
        process.env.JAVA_HOME ? process.env.JAVA_HOME + '/bin/java' : '',
        'java (PATH)',
      ]
        .filter(Boolean)
        .join(', ')}`,
    );
  }

  let jarPath: string;
  try {
    const jar = await ensureJar();
    jarPath = jar.jarPath;
    log.info(`Using cql-language-server jar: ${jarPath} (source=${jar.source})`);
  } catch (err) {
    if (err instanceof JarInstallError) {
      throw new Error(
        `Failed to obtain the cql-language-server jar: ${err.message}. ` +
          `Set CQL_LS_JAR_PATH to a local jar to bypass download.`,
      );
    }
    throw err;
  }

  const lsProcess = new CqlLsProcess({
    javaPath: java.javaPath,
    jarPath,
    workspacePath: workspaceRoot,
    logFile: process.env.CQL_DEBUG_MCP_LOG_FILE,
  });

  const debugSession = new DapSession({ ls: lsProcess });

  const context: McpContext = {
    process: lsProcess,
    debugSession,
    jarPath,
    javaVersion: java.version,
    workspaceRoot,
  };

  const tools: Tool[] = [
    getStatusTool,
    executeCqlTool,
    viewElmTool,
    ...buildDebugTools(debugSession),
    ...buildTestPipelineTools(),
  ];

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = requireTool(tools, request.params.name);
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    log.info(`Calling tool ${tool.name}`, safeLogArgs(args));
    try {
      const result = await tool.handler(context, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      log.error(`Tool ${tool.name} failed`, { message: err instanceof Error ? err.message : err });
      if (err instanceof McpError) {
        throw err;
      }
      if (err instanceof LanguageServerCrashedError) {
        throw new McpError(
          ErrorCode.InternalError,
          `language_server_crashed: ${JSON.stringify(err.crash)}`,
        );
      }
      throw new McpError(
        ErrorCode.InternalError,
        err instanceof Error ? err.message : String(err),
      );
    }
  });

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
  log.info(`${SERVER_NAME} ${SERVER_VERSION} ready (workspace=${workspaceRoot}, java=${java.javaPath} v${java.version})`);
}

function safeLogArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 200) {
      clone[key] = value.slice(0, 200) + '...';
    } else {
      clone[key] = value;
    }
  }
  return clone;
}

start().catch((err) => {
  log.error('Fatal startup error', { message: err instanceof Error ? err.message : err });
  process.stderr.write(`mcp-cql-debug: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});