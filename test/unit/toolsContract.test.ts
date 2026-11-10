import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DapSession } from '../../src/dap/dapSession.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildAllTools } from '../../src/tools/allTools.js';
import type { McpContext } from '../../src/tools/defs.js';
import { registerTools } from '../../src/tools/register.js';
import { contractOf, type ToolContract } from '../helpers/toolsContract.js';

// `tools/list` is a contract (ADR-0004 §2.2): this test compares each tool's name, description,
// required arguments and per-argument schema with a checked-in fixture, so any change shows up in
// review. Update the fixture on purpose with `UPDATE_TOOLS_CONTRACT=1 npm run test:unit`, then
// review the diff; never as a side effect.
const FIXTURE = path.resolve(__dirname, '..', '..', '..', 'test', 'fixtures', 'tools-contract.json');

/** The contract as a client sees it: `tools/list` from a real McpServer over an in-memory transport. */
async function currentContract(): Promise<ToolContract[]> {
  // The DapSession and context are never used: only tools/list is called.
  const tools = buildAllTools(new DapSession({ ls: {} as never }));
  const server = new McpServer({ name: 'contract', version: '0' });
  registerTools(server, tools, {} as McpContext);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'contract-test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return contractOf((await client.listTools()).tools);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('tools/list contract', () => {
  it('lists the 19 tools', async () => {
    expect(await currentContract()).to.have.length(19);
  });

  it('matches the checked-in contract (test/fixtures/tools-contract.json)', async () => {
    const actual = await currentContract();
    if (process.env.UPDATE_TOOLS_CONTRACT === '1') {
      fs.writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as ToolContract[];
    expect(actual).to.deep.equal(expected);
  });
});
