import { expect } from 'chai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DapSession } from '../../src/dap/dapSession.js';
import { buildAllTools } from '../../src/tools/allTools.js';
import type { McpContext } from '../../src/tools/defs.js';
import { registerTools } from '../../src/tools/register.js';

// ADR-0004 §2.3, hard-coded on purpose: a new tool without a row here fails this test, and a
// changed classification must be changed here too.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const STATEFUL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const CLASSIFICATION: Record<string, typeof READ_ONLY> = {
  cql_get_status: READ_ONLY,
  cql_get_signatures: READ_ONLY,
  cql_resolve_includes: READ_ONLY,
  cql_validate: READ_ONLY,
  cql_view_elm: READ_ONLY,
  cql_execute: READ_ONLY,
  cql_test_list_runs: READ_ONLY,
  cql_test_diff: READ_ONLY,
  cql_debug_start: STATEFUL,
  cql_debug_set_breakpoints: STATEFUL,
  cql_debug_continue: STATEFUL,
  cql_debug_next: STATEFUL,
  cql_debug_step_in: STATEFUL,
  cql_debug_step_out: STATEFUL,
  cql_debug_get_variables: STATEFUL,
  cql_debug_evaluate: STATEFUL,
  cql_debug_stop: STATEFUL,
  // Write run records under .cql-debug/test-runs/.
  cql_test_run_file: STATEFUL,
  cql_test_run_suite: STATEFUL,
};

describe('tool annotations (ADR-0004 §2.3)', () => {
  it('every registered tool has exactly its classified annotations, and none is unclassified', async () => {
    const server = new McpServer({ name: 'annotations', version: '0' });
    registerTools(server, buildAllTools(new DapSession({ ls: {} as never })), {} as McpContext);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'annotations-test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = (await client.listTools()).tools;
      expect(listed.map((t) => t.name).sort()).to.deep.equal(Object.keys(CLASSIFICATION).sort());
      for (const tool of listed) {
        expect(tool.annotations, tool.name).to.deep.equal(CLASSIFICATION[tool.name]);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
