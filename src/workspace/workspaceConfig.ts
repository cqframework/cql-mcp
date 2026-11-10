import { readEnv } from './env.js';

export interface WorkspaceConfig {
  rootDir: string;
}

export function resolveWorkspaceRoot(): string {
  return readEnv('CQL_MCP_WORKSPACE', 'CQL_DEBUG_MCP_WORKSPACE') ?? process.cwd();
}