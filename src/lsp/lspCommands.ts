import type { ExecuteCqlRequest, ExecuteCqlResponse, VersionInfo } from './protocol.js';
import type { LspClient } from './lspClient.js';

export const EXECUTE_CQL = 'org.opencds.cqf.cql.ls.executeCql';
export const VIEW_ELM = 'org.opencds.cqf.cql.ls.viewElm';
export const GET_VERSION_INFO = 'org.opencds.cqf.cql.ls.getVersionInfo';

/**
 * Not exported by vscode-cql/src/commands/commands.ts — only exists as
 * START_DEBUG_COMMAND inside DebugCommandContribution.kt. Declared locally.
 */
export const START_DEBUG_SESSION = 'org.opencds.cqf.cql.debug.startDebugSession';

export function executeCql(client: LspClient, request: ExecuteCqlRequest): Promise<ExecuteCqlResponse> {
  return client.sendExecuteCommand(EXECUTE_CQL, [request]) as Promise<ExecuteCqlResponse>;
}

export function viewElm(
  client: LspClient,
  cqlFileUri: string,
  elmType: 'xml' | 'json' | 'ast',
): Promise<string> {
  return client.sendExecuteCommand(VIEW_ELM, [cqlFileUri, elmType]) as Promise<string>;
}

export function getVersionInfo(client: LspClient): Promise<VersionInfo> {
  return client.sendExecuteCommand(GET_VERSION_INFO, []) as Promise<VersionInfo>;
}

/**
 * LSP command `org.opencds.cqf.cql.debug.startDebugSession`. The LS opens a
 * loopback ServerSocket on an OS-assigned port and returns its `localPort` as
 * an integer; the caller must dial that port within 10 seconds or the session
 * dies. There is one active session per JVM — a second call before the first
 * ends raises IllegalStateException on the LS side.
 */
export function startDebugSession(client: LspClient): Promise<number> {
  return client.sendExecuteCommand(START_DEBUG_SESSION, []) as Promise<number>;
}