import type { CqlLsProcess } from '../jvm/cqlLsProcess.js';
import type { RuntimeResolver } from '../jvm/runtimeResolver.js';
import type { DapSession } from '../dap/dapSession.js';

export interface McpContext {
  process: CqlLsProcess;
  debugSession: DapSession;
  runtime: RuntimeResolver;
  workspaceRoot: string;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (ctx: McpContext, args: Record<string, unknown>) => Promise<unknown>;
}

export function missing(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (value === undefined || value === null || value === '') {
    return `Missing required argument: ${key}`;
  }
  return null;
}

export function expectString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (value !== undefined && typeof value !== 'string') {
    return `Argument '${key}' must be a string`;
  }
  return null;
}