import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_RESPAWN_LIMIT, LanguageServerCrashedError } from '../jvm/cqlLsProcess.js';
import { log } from '../log.js';
import type { McpContext, Tool } from './defs.js';

/**
 * Compact JSON, never indented (ADR-0004 §2.4). Handlers may return undefined (JSON.stringify
 * gives undefined for that), so fall back to `null`.
 */
export function toTextResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) ?? 'null' }] };
}

/**
 * A readable sentence first, then the crash details as JSON (ADR-0004 §2.1). The next tool call that
 * needs the language server starts a new one (CqlLsProcess.ensureReady), at most
 * DEFAULT_RESPAWN_LIMIT per cql-mcp session, the first included.
 */
export function crashMessage(err: LanguageServerCrashedError, logFile?: string): string {
  const { exitCode, signal } = err.crash;
  const how = `exit code ${exitCode ?? 'unknown'}${signal ? `, signal ${signal}` : ''}`;
  const where = logFile
    ? `the LS log at ${logFile}`
    : 'the LS log (set CQL_MCP_LOG_FILE to write one)';
  return (
    `The CQL language server crashed (${how}). The next tool call that needs it starts a new one ` +
    `(cql-mcp starts at most ${DEFAULT_RESPAWN_LIMIT} per session); if it keeps crashing, check stderrTail below or ${where}, ` +
    `or set CQL_MCP_LOG_LEVEL=debug. Details: ${JSON.stringify({ kind: err.kind, ...err.crash })}`
  );
}

/** A tool failure as a result the model can read (ADR-0004 §2.1). */
export function toErrorResult(err: unknown): CallToolResult {
  let text = err instanceof Error ? err.message : String(err);
  if (err instanceof LanguageServerCrashedError) {
    text = crashMessage(err, process.env.CQL_MCP_LOG_FILE);
  }
  return { isError: true, content: [{ type: 'text', text }] };
}

function safeLogArgs(args: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    clone[key] = typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}...` : value;
  }
  return clone;
}

/**
 * Registers every tool on an McpServer (ADR-0004 §2.2). The SDK's own tools/call handler validates
 * arguments against the zod shape (a failure is an `isError` result) and passes the parsed
 * arguments, defaults applied, to the callback. The callback calls the handler and returns compact
 * JSON; any throw becomes an `isError` result. The SDK's handler is never replaced.
 */
export function registerTools(server: McpServer, tools: Tool[], ctx: McpContext): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        log.info(`Calling tool ${tool.name}`, safeLogArgs(args));
        try {
          return toTextResult(await tool.handler(ctx, args));
        } catch (err) {
          log.error(`Tool ${tool.name} failed`, { message: err instanceof Error ? err.message : err });
          return toErrorResult(err);
        }
      },
    );
  }
}
