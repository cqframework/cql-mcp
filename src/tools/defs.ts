import type { ZodRawShape } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { CqlLsProcess } from '../jvm/cqlLsProcess.js';
import type { RuntimeResolver } from '../jvm/runtimeResolver.js';
import type { DapSession } from '../dap/dapSession.js';

export interface McpContext {
  process: CqlLsProcess;
  debugSession: DapSession;
  runtime: RuntimeResolver;
  workspaceRoot: string;
}

/**
 * A tool. `inputSchema` is a zod raw shape (ADR-0004 §2.2): src/tools/register.ts validates
 * arguments against it, and `tools/list` publishes its JSON schema. Handlers receive the
 * validated arguments, and report any failure by throwing (the adapter turns it into an
 * `isError` result).
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  annotations?: ToolAnnotations;
  handler: (ctx: McpContext, args: Record<string, unknown>) => Promise<unknown>;
}
