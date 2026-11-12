import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { DapSession } from '../../src/dap/dapSession.js';
import { SERVER_INSTRUCTIONS } from '../../src/instructions.js';
import { createMcpServer } from '../../src/server.js';
import { buildAllTools } from '../../src/tools/allTools.js';
import type { McpContext } from '../../src/tools/defs.js';

// ADR-0005: agent guidance is checked against the real tool surface, so renaming a tool or an
// argument breaks the guidance in the same PR. Two documents carry guidance: the server
// `instructions` and skills/cql-mcp/SKILL.md.

const MAX_INSTRUCTIONS_CHARS = 2000;
const SKILL = path.resolve(__dirname, '..', '..', '..', 'skills', 'cql-mcp', 'SKILL.md');
// A Windows checkout may convert SKILL.md to CRLF (core.autocrlf), so compare on LF.
const SKILL_TEXT = fs.existsSync(SKILL) ? fs.readFileSync(SKILL, 'utf8').replace(/\r\n/g, '\n') : '';

const tools = buildAllTools({} as DapSession);
const shapes = new Map(tools.map((t) => [t.name, Object.keys(t.inputSchema)]));

/** Every `cql_*` token in `text`, deduplicated. */
function toolNames(text: string): string[] {
  return [...new Set(text.match(/\bcql_[a-z_]+\b/g) ?? [])];
}

/**
 * (tool, argument) pairs each document uses, written out by hand: the argument must exist in the
 * tool's zod shape and the document must still mention it. Keep these in step with the text.
 */
const INSTRUCTIONS_PAIRS: Array<[string, string]> = [
  ['cql_validate', 'content'],
  ['cql_view_elm', 'elmType'],
  ['cql_view_elm', 'maxChars'],
  ['cql_execute', 'maxChars'],
  ['cql_test_run_suite', 'suiteRoot'],
  ['cql_test_run_suite', 'suiteName'],
  ['cql_test_diff', 'suiteName'],
  ['cql_test_diff', 'runA'],
  ['cql_test_diff', 'runB'],
  ['cql_debug_start', 'testCaseDir'],
];

const SKILL_PAIRS: Array<[string, string]> = [
  ['cql_get_signatures', 'includePrivate'],
  ['cql_resolve_includes', 'alias'],
  ['cql_validate', 'content'],
  ['cql_validate', 'timeoutMs'],
  ['cql_validate', 'quiescenceMs'],
  ['cql_view_elm', 'elmType'],
  ['cql_view_elm', 'maxChars'],
  ['cql_execute', 'contextValues'],
  ['cql_execute', 'modelUri'],
  ['cql_execute', 'parameters'],
  ['cql_execute', 'maxChars'],
  ['cql_test_run_suite', 'cqlFile'],
  ['cql_test_run_suite', 'suiteRoot'],
  ['cql_test_run_suite', 'suiteName'],
  ['cql_test_run_suite', 'excludeTestCases'],
  ['cql_test_run_suite', 'configPath'],
  ['cql_test_run_suite', 'workspaceRoot'],
  ['cql_test_run_file', 'contextValues'],
  ['cql_test_run_file', 'modelUri'],
  ['cql_test_list_runs', 'suiteName'],
  ['cql_test_list_runs', 'limit'],
  ['cql_test_diff', 'suiteName'],
  ['cql_test_diff', 'runA'],
  ['cql_test_diff', 'runB'],
  ['cql_debug_start', 'cqlFile'],
  ['cql_debug_start', 'testCaseDir'],
  ['cql_debug_start', 'breakpoints'],
  ['cql_debug_start', 'parameters'],
  ['cql_debug_start', 'rootDir'],
  ['cql_debug_set_breakpoints', 'lines'],
  ['cql_debug_continue', 'timeoutMs'],
  ['cql_debug_next', 'timeoutMs'],
  ['cql_debug_get_variables', 'frameId'],
  ['cql_debug_get_variables', 'variablesReference'],
  ['cql_debug_get_variables', 'maxChars'],
];

function checkDocument(label: string, text: string, pairs: Array<[string, string]>): void {
  describe(label, () => {
    it('names only registered cql_* tools', () => {
      const unknown = toolNames(text).filter((n) => !shapes.has(n));
      expect(unknown).to.deep.equal([]);
    });

    for (const [tool, arg] of pairs) {
      it(`${tool} has argument ${arg}, and the text still mentions it`, () => {
        expect(shapes.get(tool), `${tool} is not a registered tool`).to.not.equal(undefined);
        expect(shapes.get(tool)).to.include(arg);
        expect(text).to.include(arg);
      });
    }
  });
}

describe('agent guidance (ADR-0005)', () => {
  describe('server instructions', () => {
    it(`are at most ${MAX_INSTRUCTIONS_CHARS} characters`, () => {
      expect(SERVER_INSTRUCTIONS.length).to.be.greaterThan(0);
      expect(SERVER_INSTRUCTIONS.length).to.be.at.most(MAX_INSTRUCTIONS_CHARS);
    });

    it('are returned by initialize', async () => {
      const server = createMcpServer(tools, {} as McpContext);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'test-client', version: '0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        expect(client.getInstructions()).to.equal(SERVER_INSTRUCTIONS);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  checkDocument('SERVER_INSTRUCTIONS', SERVER_INSTRUCTIONS, INSTRUCTIONS_PAIRS);

  describe('skill file', () => {
    it('exists with the cql-mcp name and a "Use when" description', () => {
      expect(SKILL_TEXT).to.match(/^---\nname: cql-mcp\n/);
      expect(SKILL_TEXT).to.match(/\ndescription: Use when/);
    });
  });

  checkDocument('SKILL.md', SKILL_TEXT, SKILL_PAIRS);
});
