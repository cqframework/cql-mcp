import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DapSession } from '../../../src/dap/dapSession.js';
import { boundVariables } from '../../../src/tools/debugTools.js';
import { boundExecuteResult, type CqlExecuteResult } from '../../../src/tools/executeCqlTool.js';
import { buildAllTools } from '../../../src/tools/allTools.js';
import type { McpContext } from '../../../src/tools/defs.js';
import { registerTools } from '../../../src/tools/register.js';
import { viewElmTool } from '../../../src/tools/viewElmTool.js';

// ADR-0004 §2.4: cql_view_elm, cql_execute and cql_debug_get_variables are bounded by maxChars.

function executeResult(n: number, valueLength: number): CqlExecuteResult {
  return {
    success: true,
    results: [
      {
        libraryName: 'Lib',
        expressions: Array.from({ length: n }, (_, i) => ({ name: `Expr${i}`, value: 'x'.repeat(valueLength) })),
      },
    ],
    diagnostics: [],
    logs: [],
  };
}

describe('maxChars', () => {
  describe('cql_execute (drops trailing expressions and lists them)', () => {
    it('leaves a result under the limit untouched', () => {
      const r = executeResult(3, 10);
      expect(boundExecuteResult(r, 50_000)).to.equal(r);
    });

    it('over the limit: keeps a prefix, lists the omitted names, marks truncated with totalChars', () => {
      const r = executeResult(100, 100); // ~ 100 * 130 chars
      const total = JSON.stringify(r).length;
      const out = boundExecuteResult(r, 2_000) as ReturnType<typeof boundExecuteResult> & Record<string, unknown>;
      expect(out.truncated).to.equal(true);
      expect(out.totalChars).to.equal(total);
      expect(out.maxChars).to.equal(2_000);
      const kept = (out as CqlExecuteResult).results[0]!.expressions;
      expect(kept.length).to.be.greaterThan(0).and.lessThan(100);
      expect(kept.map((e) => e.name)).to.deep.equal(Array.from({ length: kept.length }, (_, i) => `Expr${i}`));
      expect(out.omittedCount).to.equal(100 - kept.length);
      expect((out.omittedExpressions as string[])[0]).to.equal(`Expr${kept.length}`);
      expect(JSON.stringify(out).length).to.be.at.most(2_000);
    });

    it('keeps diagnostics and success when truncating', () => {
      const r = executeResult(50, 200);
      r.success = false;
      r.diagnostics = [{ name: 'Error', value: 'boom' }];
      const out = boundExecuteResult(r, 1_500) as CqlExecuteResult;
      expect(out.success).to.equal(false);
      expect(out.diagnostics).to.deep.equal([{ name: 'Error', value: 'boom' }]);
    });

    it('keeps the first expression, cut, when not even one fits', () => {
      const r = executeResult(2, 5_000);
      const out = boundExecuteResult(r, 1_000) as CqlExecuteResult & { omittedCount: number };
      const kept = out.results[0]!.expressions;
      expect(kept).to.have.length(1);
      expect(kept[0]!.value.endsWith('…[cut]')).to.equal(true);
      expect(out.omittedCount).to.equal(1);
      expect(JSON.stringify(out).length).to.be.at.most(1_000);
    });

    it('counts log lines that do not fit', () => {
      const r = executeResult(1, 10);
      r.logs = Array.from({ length: 500 }, (_, i) => `log line number ${i}`);
      const out = boundExecuteResult(r, 1_000) as CqlExecuteResult & { omittedLogLines: number };
      expect(out.logs.length + out.omittedLogLines).to.equal(500);
      expect(out.omittedLogLines).to.be.greaterThan(0);
    });
  });

  describe('cql_debug_get_variables (drops trailing variables and lists them)', () => {
    const vars = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `v${i}`, value: 'y'.repeat(100) }));

    it('leaves a result under the limit untouched', () => {
      const r = { variables: vars(3) };
      expect(boundVariables(r, 50_000)).to.equal(r);
    });

    it('bounds a flat variables result', () => {
      const out = boundVariables({ variables: vars(100) }, 2_000) as { variables: unknown[]; omittedCount: number; omittedVariables: string[]; truncated: boolean; totalChars: number };
      expect(out.truncated).to.equal(true);
      expect(out.totalChars).to.be.greaterThan(2_000);
      expect(out.variables.length + out.omittedCount).to.equal(100);
      expect(out.omittedVariables[0]).to.equal(`v${out.variables.length}`);
      expect(JSON.stringify(out).length).to.be.at.most(2_000);
    });

    it('bounds across scopes, keeping every scope header', () => {
      const r = { scopes: [{ name: 'Locals', variablesReference: 1, variables: vars(30) }, { name: 'Globals', variablesReference: 2, variables: vars(30) }] };
      const out = boundVariables(r, 2_500) as { scopes: Array<{ name: string; variables: unknown[] }>; omittedCount: number; truncated: boolean };
      expect(out.scopes.map((s) => s.name)).to.deep.equal(['Locals', 'Globals']);
      expect(out.truncated).to.equal(true);
      const keptTotal = out.scopes.reduce((n, s) => n + s.variables.length, 0);
      expect(keptTotal + out.omittedCount).to.equal(60);
      // A clean prefix: nothing kept in Globals unless all of Locals fit.
      if (out.scopes[0]!.variables.length < 30) expect(out.scopes[1]!.variables).to.have.length(0);
    });
  });

  describe('cql_view_elm (bounds the serialized result)', () => {
    let dir: string;
    let file: string;
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxchars-'));
      file = path.join(dir, 'X.cql');
      fs.writeFileSync(file, "library X version '1.0.0'\n");
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const ctxWith = (elm: string) =>
      ({
        workspaceRoot: dir,
        process: {
          ensureReady: async () => undefined,
          lspClient: { sendNotification: () => undefined },
          executeCommand: async () => elm,
        },
      }) as unknown as McpContext;
    const run = async (elm: string, maxChars?: number) =>
      (await viewElmTool.handler(ctxWith(elm), { cqlFile: file, elmType: 'json', ...(maxChars ? { maxChars } : {}) })) as Record<string, unknown>;

    // Every quote in JSON ELM is escaped when serialized, so the raw length understates the result.
    const quoteHeavy = (rawLength: number) => '{"a":"b"}'.repeat(Math.ceil(rawLength / 9)).slice(0, rawLength);

    it('returns the result unchanged when its serialized form fits', async () => {
      const out = await run('<library/>', 5_000);
      expect(out.content).to.equal('<library/>');
      expect(out).to.not.have.property('truncated');
    });

    it('content just under the raw limit still truncates when its serialized form is over', async () => {
      const elm = quoteHeavy(990); // raw 990 < 1000, but serialized ~ 1500+
      const out = await run(elm, 1_000);
      expect(elm.length).to.be.lessThan(1_000);
      expect(out.truncated).to.equal(true);
      expect(JSON.stringify(out).length).to.be.at.most(1_000);
      expect(elm.startsWith(out.content as string)).to.equal(true);
    });

    it('quote-heavy content over the limit: serialized length <= maxChars, totalChars is the full serialized length', async () => {
      const elm = quoteHeavy(60_000);
      const out = await run(elm, 50_000);
      const full = JSON.stringify({ cqlFile: path.resolve(file), elmType: 'json', content: elm }).length;
      expect(out.truncated).to.equal(true);
      expect(out.totalChars).to.equal(full);
      expect(out.maxChars).to.equal(50_000);
      const serialized = JSON.stringify(out).length;
      expect(serialized).to.be.at.most(50_000);
      // Tight: the cut is the longest prefix that fits (one more character would not).
      expect(serialized).to.be.greaterThan(50_000 - 8);
      expect(elm.startsWith(out.content as string)).to.equal(true);
    });

    it('XML (few escapes) over the limit: bounded the same way', async () => {
      const elm = '<library>' + 'a'.repeat(10_000) + '</library>';
      const out = await run(elm, 1_000);
      expect(out.truncated).to.equal(true);
      expect(JSON.stringify(out).length).to.be.at.most(1_000);
      expect(JSON.stringify(out).length).to.be.greaterThan(1_000 - 4);
      expect(out.totalChars).to.equal(JSON.stringify({ cqlFile: path.resolve(file), elmType: 'json', content: elm }).length);
    });

    it('uses the default limit (50000) when maxChars is omitted', async () => {
      const out = await run('b'.repeat(60_000));
      expect(out.maxChars).to.equal(50_000);
      expect(JSON.stringify(out).length).to.be.at.most(50_000);
    });

    it('newlines and non-ASCII are counted by their serialized size', async () => {
      const elm = 'line é\n'.repeat(5_000);
      const out = await run(elm, 2_000);
      expect(JSON.stringify(out).length).to.be.at.most(2_000);
    });
  });

  describe('schema', () => {
    for (const [tool, args] of [
      ['cql_view_elm', { cqlFile: '/x/lib.cql' }],
      ['cql_execute', { cqlFile: '/x/lib.cql' }],
      ['cql_debug_get_variables', { frameId: 1 }],
    ] as const) {
      it(`${tool}: maxChars 999 is rejected, 1000 and the default pass validation`, async () => {
        const session = new DapSession({ ls: {} as never });
        const server = new McpServer({ name: 'maxchars', version: '0' });
        registerTools(server, buildAllTools(session), {} as McpContext);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'maxchars-test', version: '0' });
        await Promise.all([server.connect(st), client.connect(ct)]);
        try {
          const call = async (extra: Record<string, unknown>) => {
            const r = await client.callTool({ name: tool, arguments: { ...args, ...extra } });
            return { isError: r.isError === true, text: (r.content as Array<{ text: string }>)[0]!.text };
          };
          const rejected = await call({ maxChars: 999 });
          expect(rejected.isError).to.equal(true);
          expect(rejected.text).to.include('Input validation error');
          expect(rejected.text).to.include('maxChars');
          // 1000 passes validation (the handler then fails for another reason: no real LS/file).
          for (const extra of [{ maxChars: 1000 }, {}]) {
            expect((await call(extra)).text).to.not.include('Input validation error');
          }
        } finally {
          await client.close();
          await server.close();
        }
      });
    }
  });
});
