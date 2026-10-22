import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CqlLsProcess } from '../../../src/jvm/cqlLsProcess.js';
import type { DapSession } from '../../../src/dap/dapSession.js';
import type { McpContext } from '../../../src/tools/defs.js';
import {
  buildTestPipelineTools,
  diffTool,
  listRunsTool,
  runFileTool,
  runSuiteTool,
} from '../../../src/tools/testPipelineTools.js';

interface MockProcessState {
  /** Each entry is one "library response" — combined into a single executeCql response. */
  queue: Array<unknown>;
  /** When true, queue items are consumed one-per-result inside a single executeCql call. */
  fanOutPerQueueItem: boolean;
}

function mkContext(opts: {
  workspaceRoot: string;
  queue?: Array<unknown>;
  ensureReadyImpl?: () => Promise<void>;
  fanOutPerQueueItem?: boolean;
}): McpContext {
  const state: MockProcessState = {
    queue: opts.queue ?? [],
    fanOutPerQueueItem: opts.fanOutPerQueueItem ?? false,
  };
  const proc = {
    ensureReady: opts.ensureReadyImpl ?? (async () => undefined),
    lspClient: { sendNotification: () => undefined },
    executeCommand: async (_cmd: string, args: unknown[]) => {
      if (state.fanOutPerQueueItem) {
        // Match the real LS semantics: one executeCql call returns one LibraryResult per library in the request.
        const req = (args as Array<{ libraries: Array<{ libraryName: string }> }>)[0];
        const results = [];
        for (let i = 0; i < req.libraries.length; i++) {
          const next = state.queue.shift();
          if (!next) throw new Error('mock queue exhausted mid-request');
          if (next instanceof Error) throw next;
          // Each queued item can be either a LibraryResult or { libraryName, expressions, ... }.
          if (typeof next === 'object' && next !== null && 'libraryName' in next) {
            results.push(next);
          } else {
            results.push({ libraryName: req.libraries[i].libraryName, expressions: [], ...(next as object) });
          }
        }
        return { results, logs: [], versions: { languageServer: '4.10.0' } };
      }
      // Non-fanOut mode: each executeCommand returns a single full ExecuteCqlResponse.
      // Wrap a bare { expressions } item into the canonical response shape.
      const req = (args as Array<{ libraries: Array<{ libraryName: string }> }>)[0];
      const next = state.queue.shift();
      if (!next) throw new Error('mock queue empty');
      if (next instanceof Error) throw next;
      if (typeof next === 'object' && next !== null && 'results' in next) {
        return next;
      }
      return {
        results: [{ libraryName: req.libraries[0].libraryName, expressions: [], ...(next as object) }],
        logs: [],
        versions: { languageServer: '4.10.0' },
      };
    },
  } as unknown as CqlLsProcess;
  return {
    process: proc,
    debugSession: {} as DapSession,
    jarPath: '/dummy.jar',
    javaVersion: 17,
    workspaceRoot: opts.workspaceRoot,
  };
}

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tpt-'));
}

describe('tools/testPipelineTools', () => {
  describe('buildTestPipelineTools', () => {
    it('returns 4 tools with stable names', () => {
      const tools = buildTestPipelineTools();
      expect(tools.map((t) => t.name)).to.deep.equal([
        'cql_test_run_file',
        'cql_test_run_suite',
        'cql_test_list_runs',
        'cql_test_diff',
      ]);
      expect(tools).to.have.length(4);
    });
  });

  describe('runFileTool', () => {
    it('requires cqlFile', async () => {
      const ctx = mkContext({ workspaceRoot: mkRoot() });
      try {
        await runFileTool.handler(ctx, {});
      } catch (e) {
        expect((e as Error).message).to.include('cqlFile');
        return;
      }
      expect.fail('expected throw');
    });

    it('persists run via suiteRunner.runFile and returns RunRecord', async () => {
      const root = mkRoot();
      const cqlFile = path.join(root, 'L.cql');
      fs.writeFileSync(cqlFile, 'library L version "1.0.0"');
      const ctx = mkContext({
        workspaceRoot: root,
        fanOutPerQueueItem: true,
        queue: [{ expressions: [{ name: 'M', value: 'true' }] }],
      });
      try {
        const result = (await runFileTool.handler(ctx, {
          cqlFile,
          contextValues: ['p1'],
          suiteName: 'L',
        })) as { cases: Array<{ patientId: string; status: string }>; hash: string };
        expect(result.cases[0].patientId).to.equal('p1');
        expect(result.cases[0].status).to.equal('passed');
        expect(result.hash).to.match(/^[0-9a-f]{64}$/);
        // Pointer written
        const ptrPath = path.join(root, '.cql-debug', 'test-runs', 'latest-L.json');
        expect(fs.existsSync(ptrPath)).to.equal(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('runSuiteTool', () => {
    it('requires cqlFile, suiteRoot, suiteName', async () => {
      const ctx = mkContext({ workspaceRoot: mkRoot() });
      try {
        await runSuiteTool.handler(ctx, { suiteRoot: '/x', suiteName: 'S' });
      } catch (e) {
        expect((e as Error).message).to.include('cqlFile');
        return;
      }
      expect.fail('expected throw');
    });

    it('runs discovered cases', async () => {
      const root = mkRoot();
      const cqlFile = path.join(root, 'L.cql');
      fs.writeFileSync(cqlFile, 'library L version "1.0.0"');
      const suiteRoot = path.join(root, 'suites');
      fs.mkdirSync(path.join(suiteRoot, 'L', 'p1'), { recursive: true });
      fs.mkdirSync(path.join(suiteRoot, 'L', 'p2'), { recursive: true });
      // runSuite makes N executeCommand calls (one per case), each returns one library result.
      const ctx = mkContext({
        workspaceRoot: root,
        queue: [
          { expressions: [] },
          { expressions: [] },
        ],
      });
      try {
        const result = (await runSuiteTool.handler(ctx, {
          cqlFile,
          suiteRoot,
          suiteName: 'L',
        })) as { cases: Array<{ patientId: string }> };
        expect(result.cases.map((c) => c.patientId).sort()).to.deep.equal(['p1', 'p2']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('listRunsTool', () => {
    it('returns runs grouped by suite', async () => {
      const root = mkRoot();
      const ctx = mkContext({ workspaceRoot: root });
      try {
        // Seed two runs for suite "A" and one for "B" via the runFile tool.
        const cqlA = path.join(root, 'A.cql');
        const cqlB = path.join(root, 'B.cql');
        fs.writeFileSync(cqlA, 'library A version "1.0.0"');
        fs.writeFileSync(cqlB, 'library B version "1.0.0"');
        for (const [cql, suite, pids] of [
          [cqlA, 'A', ['p1']],
          [cqlA, 'A', ['p2']],
          [cqlB, 'B', ['p3']],
        ] as const) {
          const localCtx = mkContext({
            workspaceRoot: root,
            fanOutPerQueueItem: true,
            queue: pids.map(() => ({ expressions: [] })),
          });
          await runFileTool.handler(localCtx, { cqlFile: cql, contextValues: [...pids], suiteName: suite });
        }
        const all = (await listRunsTool.handler(ctx, {})) as { runs: Array<{ suiteName: string }> };
        expect(all.runs).to.have.length(3);
        const onlyA = (await listRunsTool.handler(ctx, { suiteName: 'A' })) as {
          runs: Array<{ suiteName: string }>;
        };
        expect(onlyA.runs).to.have.length(2);
        expect(onlyA.runs.every((r) => r.suiteName === 'A')).to.equal(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('diffTool', () => {
    it('returns no_previous_run status when suite has no pointer', async () => {
      const root = mkRoot();
      const ctx = mkContext({ workspaceRoot: root });
      try {
        const result = (await diffTool.handler(ctx, {
          suiteName: 'Ghost',
          runA: 'previous',
          runB: 'latest',
        })) as { status: string; message: string };
        expect(result.status).to.equal('no_previous_run');
        expect(result.message).to.include('Ghost');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('diffs two runs referenced by timestamp, and accepts pointer keywords in any case', async () => {
      const root = mkRoot();
      const cqlFile = path.join(root, 'L.cql');
      fs.writeFileSync(cqlFile, 'library L version "1.0.0"');
      try {
        const run = (values: string[]) =>
          runFileTool.handler(
            mkContext({
              workspaceRoot: root,
              fanOutPerQueueItem: true,
              queue: values.map((value) => ({ expressions: [{ name: 'X', value }] })),
            }),
            { cqlFile, contextValues: values.map((_, i) => `p${i + 1}`), suiteName: 'L' },
          ) as Promise<{ timestamp: string }>;
        const first = await run(['1']);
        await new Promise((r) => setTimeout(r, 5));
        const second = await run(['2', '3']);
        const ctx = mkContext({ workspaceRoot: root });

        const byTimestamp = (await diffTool.handler(ctx, {
          suiteName: 'L',
          runA: first.timestamp,
          runB: second.timestamp,
        })) as { added: Array<{ patientId: string }> };
        expect(byTimestamp.added.map((c) => c.patientId)).to.deep.equal(['p2']);

        const byKeyword = (await diffTool.handler(ctx, {
          suiteName: 'L',
          runA: 'Previous',
          runB: 'LATEST',
        })) as { added: Array<{ patientId: string }> };
        expect(byKeyword.added.map((c) => c.patientId)).to.deep.equal(['p2']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('diffs two persisted runs (latest vs previous)', async () => {
      const root = mkRoot();
      const cqlFile = path.join(root, 'L.cql');
      fs.writeFileSync(cqlFile, 'library L version "1.0.0"');
      const ctx = mkContext({ workspaceRoot: root });
      try {
        // Run 1: p1=1, p2=2 (contextValues [p1, p2])
        const ctx1 = mkContext({
          workspaceRoot: root,
          fanOutPerQueueItem: true,
          queue: [
            { expressions: [{ name: 'X', value: '1' }] },
            { expressions: [{ name: 'X', value: '2' }] },
          ],
        });
        await runFileTool.handler(ctx1, { cqlFile, contextValues: ['p1', 'p2'], suiteName: 'L' });
        await new Promise((r) => setTimeout(r, 5));
        // Run 2: p1=99, p2=2, p3=added (different contextValues → different content hash → distinguishable files)
        const ctx2 = mkContext({
          workspaceRoot: root,
          fanOutPerQueueItem: true,
          queue: [
            { expressions: [{ name: 'X', value: '99' }] },
            { expressions: [{ name: 'X', value: '2' }] },
            { expressions: [{ name: 'X', value: '3' }] },
          ],
        });
        await runFileTool.handler(ctx2, { cqlFile, contextValues: ['p1', 'p2', 'p3'], suiteName: 'L' });

        const diff = (await diffTool.handler(ctx, {
          suiteName: 'L',
          runA: 'previous',
          runB: 'latest',
        })) as {
          added: Array<{ patientId: string }>;
          removed: unknown[];
          changed: Array<{ patientId: string; expressionName: string; before: string; after: string; kind?: string }>;
          unchangedCount: number;
        };
        expect(diff.removed).to.have.length(0);
        expect(diff.added.map((c) => c.patientId)).to.deep.equal(['p3']);
        expect(diff.changed).to.deep.equal([
          { patientId: 'p1', expressionName: 'X', before: '1', after: '99', kind: 'value-changed' },
        ]);
        expect(diff.unchangedCount).to.equal(1);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
