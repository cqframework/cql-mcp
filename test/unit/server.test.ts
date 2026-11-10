import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { CqlLsProcess, LanguageServerCrashedError } from '../../src/jvm/cqlLsProcess.js';
import { RuntimeResolver } from '../../src/jvm/runtimeResolver.js';
import type { DapSession } from '../../src/dap/dapSession.js';
import { buildAllTools } from '../../src/tools/allTools.js';
import type { McpContext, Tool } from '../../src/tools/defs.js';
import { registerTools } from '../../src/tools/register.js';

// The adapter (src/tools/register.ts) alone maps failures to isError results (ADR-0004 §2.1) and
// validates arguments against the zod schemas (§2.2). These tests drive a real McpServer through
// an in-memory client, the way a stdio client would.

interface Harness {
  client: Client;
  close(): Promise<void>;
}

async function connect(tools: Tool[], ctx: Partial<McpContext> = {}): Promise<Harness> {
  const server = new McpServer({ name: 'test', version: '0' });
  registerTools(server, tools, ctx as McpContext);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function call(h: Harness, name: string, args?: Record<string, unknown>) {
  const result = await h.client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { isError: result.isError === true, text: content.map((c) => c.text).join('') };
}

/** A fake DapSession that records what the tools pass in. */
function fakeSession() {
  const calls = { start: [] as unknown[], setBreakpoints: [] as unknown[] };
  const session = {
    isActive: false,
    async start(args: unknown) {
      calls.start.push(args);
    },
    async setBreakpoints(file: string, lines: number[]) {
      calls.setBreakpoints.push({ file, lines });
      return lines.map((line) => ({ verified: true, line }));
    },
    async stop() {
      /* nothing to stop */
    },
  };
  return { session: session as unknown as DapSession, calls };
}

describe('server (McpServer + adapter)', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  const stub = (name: string, handler: Tool['handler'], inputSchema: Tool['inputSchema'] = {}): Tool => ({
    name,
    description: `stub ${name}`,
    inputSchema,
    handler,
  });

  describe('results', () => {
    it('returns compact JSON on success', async () => {
      h = await connect([stub('ok', async () => ({ a: 1, b: [1, 2], c: { d: 'x y' } }))]);
      const r = await call(h, 'ok');
      expect(r.isError).to.equal(false);
      expect(r.text).to.equal('{"a":1,"b":[1,2],"c":{"d":"x y"}}');
    });

    it('returns null for a handler that returns undefined', async () => {
      h = await connect([stub('nothing', async () => undefined)]);
      expect(await call(h, 'nothing')).to.deep.equal({ isError: false, text: 'null' });
    });

    it('a handler that throws gives an isError result with its message', async () => {
      h = await connect([
        stub('boom', async () => {
          throw new Error('CQL file not found: /x/y.cql');
        }),
      ]);
      expect(await call(h, 'boom')).to.deep.equal({ isError: true, text: 'CQL file not found: /x/y.cql' });
    });

    it('a handler that throws a non-Error gives an isError result', async () => {
      h = await connect([
        stub('weird', async () => {
          throw 'plain string'; // eslint-disable-line no-throw-literal
        }),
      ]);
      expect(await call(h, 'weird')).to.deep.equal({ isError: true, text: 'plain string' });
    });

    it('a handler that throws McpError still gives an isError result (never a JSON-RPC error)', async () => {
      h = await connect([
        stub('mcp', async () => {
          throw new McpError(ErrorCode.InternalError, 'inner');
        }),
      ]);
      const r = await call(h, 'mcp');
      expect(r.isError).to.equal(true);
      expect(r.text).to.include('inner');
    });

    it('a language-server crash gives an isError result with the crash JSON', async () => {
      const crash = { exitCode: 1, signal: null, stderrTail: ['boom'] };
      h = await connect([
        stub('crash', async () => {
          throw new LanguageServerCrashedError(crash as never);
        }),
      ]);
      const r = await call(h, 'crash');
      expect(r.isError).to.equal(true);
      expect(r.text).to.equal(`language_server_crashed: ${JSON.stringify(crash)}`);
    });

    it('a missing JDK gives an isError result with the "No Java >= 17" text', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-'));
      try {
        const file = path.join(dir, 'X.cql');
        fs.writeFileSync(file, "library X version '1.0.0'\ndefine Y: 1\n");
        const runtime = new RuntimeResolver({
          findJava: () => null,
          resolveJar: async () => ({ jarPath: '/jars/cql-ls-server-5.0.0.jar', downloaded: false, source: 'env' }),
        });
        const process = new CqlLsProcess({ runtime, workspacePath: dir });
        const { session } = fakeSession();
        h = await connect(buildAllTools(session), { process, runtime, workspaceRoot: dir });
        const r = await call(h, 'cql_execute', { cqlFile: file });
        expect(r.isError).to.equal(true);
        expect(r.text).to.include('No Java >= 17 found');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('unknown tool', () => {
    // The SDK's own tools/call handler answers an unknown tool with an isError result (ADR-0004 §2.1).
    it('is an isError result whose text names the tool', async () => {
      h = await connect([stub('known', async () => 1)]);
      const r = await call(h, 'nope');
      expect(r.isError).to.equal(true);
      expect(r.text).to.include('nope');
    });
  });

  describe('input validation (isError, readable message)', () => {
    const real = async () => {
      const { session } = fakeSession();
      return connect(buildAllTools(session), { workspaceRoot: os.tmpdir() });
    };

    it('B1: set_breakpoints with lines: "5" is an isError result, not a TypeError', async () => {
      h = await real();
      const r = await call(h, 'cql_debug_set_breakpoints', { cqlFile: '/x/lib.cql', lines: '5' });
      expect(r.isError).to.equal(true);
      expect(r.text).to.include('Input validation error');
      expect(r.text).to.include('lines');
      expect(r.text).to.not.include('filter is not a function');
    });

    for (const lines of [[], [0], [-3], [1.5], ['5']]) {
      it(`B1: set_breakpoints rejects lines ${JSON.stringify(lines)}`, async () => {
        h = await real();
        const r = await call(h, 'cql_debug_set_breakpoints', { cqlFile: '/x/lib.cql', lines });
        expect(r.isError).to.equal(true);
        expect(r.text).to.include('lines');
      });
    }

    it('B1: set_breakpoints accepts positive integers', async () => {
      const { session, calls } = fakeSession();
      h = await connect(buildAllTools(session), { workspaceRoot: os.tmpdir() });
      const r = await call(h, 'cql_debug_set_breakpoints', { cqlFile: '/x/lib.cql', lines: [3, 7] });
      expect(r.isError).to.equal(false);
      expect(calls.setBreakpoints).to.deep.equal([{ file: '/x/lib.cql', lines: [3, 7] }]);
    });

    for (const limit of [-1, 0, 1001, 1.5, '5']) {
      it(`B3: list_runs rejects limit ${JSON.stringify(limit)}`, async () => {
        h = await real();
        const r = await call(h, 'cql_test_list_runs', { limit });
        expect(r.isError).to.equal(true);
        expect(r.text).to.include('limit');
      });
    }

    it('B3: list_runs accepts limit 1 and 1000', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-runs-'));
      try {
        const { session } = fakeSession();
        h = await connect(buildAllTools(session), { workspaceRoot: root });
        for (const limit of [1, 1000]) {
          const r = await call(h, 'cql_test_list_runs', { limit });
          expect(r.isError, r.text).to.equal(false);
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    const badExecuteArgs: Array<[string, Record<string, unknown>, string]> = [
      ['contextValues is a string', { contextValues: 'p1' }, 'contextValues'],
      ['contextValues has a number', { contextValues: ['p1', 2] }, 'contextValues'],
      ['parameters is a string', { parameters: 'x' }, 'parameters'],
      ['a parameter lacks value', { parameters: [{ name: 'a' }] }, 'parameters'],
      ['a parameter lacks name', { parameters: [{ value: '1' }] }, 'parameters'],
      ['parameters is a name->value object', { parameters: { a: '1' } }, 'parameters'],
      ['fhirVersion is a number', { fhirVersion: 4 }, 'fhirVersion'],
    ];
    for (const [title, extra, field] of badExecuteArgs) {
      it(`B2: cql_execute rejects bad input (${title})`, async () => {
        h = await real();
        const r = await call(h, 'cql_execute', { cqlFile: '/x/lib.cql', ...extra });
        expect(r.isError).to.equal(true);
        expect(r.text).to.include('Input validation error');
        expect(r.text).to.include(field);
      });
    }

    it('every tool with required arguments rejects {} naming each of them', async () => {
      const tools = buildAllTools(fakeSession().session);
      h = await connect(tools, { workspaceRoot: os.tmpdir() });
      const listed = (await h.client.listTools()).tools;
      let checked = 0;
      for (const t of listed) {
        const required = t.inputSchema.required ?? [];
        if (required.length === 0) continue;
        const r = await call(h, t.name, {});
        expect(r.isError, t.name).to.equal(true);
        for (const name of required) expect(r.text, `${t.name} -> ${name}`).to.include(name);
        checked += 1;
      }
      expect(checked).to.be.greaterThan(10);
    });

    it('empty cqlFile is rejected', async () => {
      h = await real();
      const r = await call(h, 'cql_validate', { cqlFile: '' });
      expect(r.isError).to.equal(true);
      expect(r.text).to.include('cqlFile');
    });

    it('arguments omitted entirely behave like {}', async () => {
      h = await connect([stub('needs', async () => 1, { x: z.string() })]);
      const r = await call(h, 'needs');
      expect(r.isError).to.equal(true);
      expect(r.text).to.include('x');
    });

    it('applies schema defaults before the handler sees the arguments', async () => {
      let seen: Record<string, unknown> = {};
      h = await connect([
        stub(
          'defaults',
          async (_ctx, args) => {
            seen = args;
            return 1;
          },
          { n: z.number().default(7) },
        ),
      ]);
      await call(h, 'defaults');
      expect(seen).to.deep.equal({ n: 7 });
    });
  });

  describe('B6: cql_debug_start.parameters accepts both forms', () => {
    const start = async (parameters: unknown) => {
      const { session, calls } = fakeSession();
      h = await connect(buildAllTools(session), { workspaceRoot: os.tmpdir(), process: { executeCommand: async () => ({}) } as never });
      const r = await call(h, 'cql_debug_start', { cqlFile: '/x/lib.cql', parameters });
      return { r, calls };
    };

    it('the documented [{ name, type, value }] form is normalized to { name: value }', async () => {
      const { r, calls } = await start([
        { name: 'MeasurementPeriodStart', type: 'DateTime', value: '2025-01-01' },
        { name: 'Count', value: '3' },
      ]);
      expect(r.isError, r.text).to.equal(false);
      expect((calls.start[0] as { parameters: unknown }).parameters).to.deep.equal({
        MeasurementPeriodStart: '2025-01-01',
        Count: '3',
      });
    });

    it('the { name: value } form still works and is passed through', async () => {
      const { r, calls } = await start({ Count: 3, Flag: true });
      expect(r.isError, r.text).to.equal(false);
      expect((calls.start[0] as { parameters: unknown }).parameters).to.deep.equal({ Count: 3, Flag: true });
    });

    it('rejects other shapes', async () => {
      const { r, calls } = await start('Count=3');
      expect(r.isError).to.equal(true);
      expect(r.text).to.include('parameters');
      expect(calls.start).to.have.length(0);
    });
  });
});
