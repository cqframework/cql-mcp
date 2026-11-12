import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import type { McpContext, Tool } from './tools/defs.js';
import { registerTools } from './tools/register.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

/**
 * The one place an McpServer is built, so index.ts and the unit tests share the real wiring: server
 * info, `instructions` (ADR-0005) and every tool.
 */
export function createMcpServer(tools: Tool[], ctx: McpContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, tools, ctx);
  return server;
}
