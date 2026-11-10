import type { DapSession } from '../dap/dapSession.js';
import type { Tool } from './defs.js';
import { executeCqlTool } from './executeCqlTool.js';
import { getStatusTool } from './statusTool.js';
import { viewElmTool } from './viewElmTool.js';
import { signaturesTool } from './signaturesTool.js';
import { resolveIncludesTool } from './resolveIncludesTool.js';
import { validateTool } from './validateTool.js';
import { buildDebugTools } from './debugTools.js';
import { buildTestPipelineTools } from './testPipelineTools.js';

/** Every tool the server exposes, in `tools/list` order. */
export function buildAllTools(debugSession: DapSession): Tool[] {
  return [
    getStatusTool,
    executeCqlTool,
    viewElmTool,
    signaturesTool,
    resolveIncludesTool,
    validateTool,
    ...buildDebugTools(debugSession),
    ...buildTestPipelineTools(),
  ];
}
