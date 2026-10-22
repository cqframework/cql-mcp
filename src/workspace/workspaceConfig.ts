export interface WorkspaceConfig {
  rootDir: string;
}

export function resolveWorkspaceRoot(): string {
  return process.env.CQL_DEBUG_MCP_WORKSPACE ?? process.cwd();
}