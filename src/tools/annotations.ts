import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * Tool annotations (ADR-0004 §2.3). "Read-only" means the user's files and the CQL project: the
 * language server's in-memory document state and cql-mcp's own caches don't count. `openWorldHint`
 * is false throughout (the first-run jar download is setup, not what a tool is for).
 */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Debug tools (they drive a stateful session) and the test-run tools (they write run records). */
export const STATEFUL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
