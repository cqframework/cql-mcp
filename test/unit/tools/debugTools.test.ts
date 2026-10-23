import { expect } from 'chai';
import type {
  DapSession,
  DebugLaunchArgs,
  DapStopEvent,
  DapScope,
  DapVariable,
  DapEvaluationResult,
} from '../../../src/dap/dapSession.js';
import { buildDebugTools, debugVersionWarning } from '../../../src/tools/debugTools.js';

interface FakeSession extends Pick<
  DapSession,
  | 'start'
  | 'setBreakpoints'
  | 'continue'
  | 'next'
  | 'stepIn'
  | 'stepOut'
  | 'scopes'
  | 'getVariables'
  | 'evaluate'
  | 'stop'
> {
  isActive: boolean;
  startedWith: DebugLaunchArgs | null;
  bpFile: string | null;
  bpLines: number[];
  evalResults: Array<{ expression: string; frameId?: number; result: string }>;
}

function makeFakeSession(): FakeSession {
  return {
    isActive: false,
    startedWith: null,
    bpFile: null,
    bpLines: [],
    evalResults: [],
    async start(args) {
      this.startedWith = args;
      this.isActive = true;
    },
    async setBreakpoints(file, lines) {
      this.bpFile = file;
      this.bpLines = lines;
      return lines.map((line) => ({ verified: true, line }));
    },
    async continue(threadId) {
      return { event: 'stopped', reason: 'breakpoint', threadId };
    },
    async next(threadId) {
      return { event: 'stopped', reason: 'step', threadId };
    },
    async stepIn(threadId) {
      return { event: 'stopped', reason: 'step', threadId };
    },
    async stepOut(threadId) {
      return { event: 'stopped', reason: 'step', threadId };
    },
    async scopes(_frameId): Promise<DapScope[]> {
      return [{ name: 'Locals', variablesReference: 7, expensive: false }];
    },
    async getVariables(_ref): Promise<DapVariable[]> {
      return [{ name: 'X', value: '1', variablesReference: 0 }];
    },
    async evaluate(expression, frameId): Promise<DapEvaluationResult> {
      this.evalResults.push({ expression, frameId, result: '42' });
      return { result: '42', type: 'Integer', variablesReference: 0 };
    },
    async stop() {
      this.isActive = false;
    },
  };
}

function findTool(name: string, session: FakeSession) {
  const tools = buildDebugTools(session as unknown as DapSession);
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
}

describe('debugTools', () => {
  it('registers all 9 debug tools', () => {
    const tools = buildDebugTools(makeFakeSession() as unknown as DapSession);
    expect(tools.map((t) => t.name)).to.deep.equal([
      'cql_debug_start',
      'cql_debug_set_breakpoints',
      'cql_debug_continue',
      'cql_debug_next',
      'cql_debug_step_in',
      'cql_debug_step_out',
      'cql_debug_get_variables',
      'cql_debug_evaluate',
      'cql_debug_stop',
    ]);
  });

  it('cql_debug_start forwards args', async () => {
    const session = makeFakeSession();
    const tool = findTool('cql_debug_start', session);
    const res = await tool.handler({} as never, { cqlFile: '/x/lib.cql' });
    expect(res).to.deep.equal({ active: true });
    expect(session.startedWith?.cqlFile).to.equal('/x/lib.cql');
  });

  it('cql_debug_start warns when the language server predates the DebugSession socket-close fix', async () => {
    const session = makeFakeSession();
    const tool = findTool('cql_debug_start', session);
    const ctx = { process: { executeCommand: async () => ({ languageServer: '4.10.0' }) } };
    const res = (await tool.handler(ctx as never, { cqlFile: '/x/lib.cql' })) as { active: boolean; warning?: string };
    expect(res.active).to.equal(true);
    expect(res.warning).to.contain('LS 4.10.0 predates the DebugSession socket-close fix');
    expect(res.warning).to.contain('CQL_LS_JAR_PATH');
  });

  it('debugVersionWarning flags only releases up to 4.10.x', () => {
    for (const v of ['4.10.0', '4.10.3', '4.9.1', '3.2.0']) {
      expect(debugVersionWarning(v), v).to.be.a('string');
    }
    for (const v of ['4.11.0-SNAPSHOT', '4.11.0', '5.0.0', 'unknown', '', null, undefined]) {
      expect(debugVersionWarning(v as string | null | undefined), String(v)).to.equal(null);
    }
  });

  it('cql_debug_start forwards breakpoints and filters non-positive integers', async () => {
    const session = makeFakeSession();
    const tool = findTool('cql_debug_start', session);
    await tool.handler(
      {} as never,
      { cqlFile: '/x/lib.cql', breakpoints: [1, 2, -3, 'bad', 0] },
    );
    expect(session.startedWith?.breakpoints).to.deep.equal([1, 2]);
  });

  it('cql_debug_start omits breakpoints when not provided', async () => {
    const session = makeFakeSession();
    const tool = findTool('cql_debug_start', session);
    await tool.handler({} as never, { cqlFile: '/x/lib.cql' });
    expect(session.startedWith?.breakpoints).to.equal(undefined);
  });

  it('cql_debug_start requires cqlFile', async () => {
    const session = makeFakeSession();
    const tool = findTool('cql_debug_start', session);
    let threw = false;
    try {
      await tool.handler({} as never, {});
    } catch (err) {
      threw = true;
      expect((err as Error).message).to.match(/Missing required argument: cqlFile/);
    }
    expect(threw).to.equal(true);
  });

  it('cql_debug_set_breakpoints filters non-positive integers', async () => {
    const session = makeFakeSession();
    const tool = findTool('cql_debug_set_breakpoints', session);
    await tool.handler({} as never, { cqlFile: '/x/lib.cql', lines: [1, 2, -3, 'bad', 0] });
    expect(session.bpLines).to.deep.equal([1, 2]);
  });

  it('cql_debug_get_variables with variablesReference bypasses scopes', async () => {
    const session = makeFakeSession();
    const tool = findTool('cql_debug_get_variables', session);
    const res = await tool.handler({} as never, { variablesReference: 7 });
    expect(res).to.deep.equal({ variables: [{ name: 'X', value: '1', variablesReference: 0 }] });
  });

  it('cql_debug_get_variables with frameId scopes-then-variables', async () => {
    const session = makeFakeSession();
    const tool = findTool('cql_debug_get_variables', session);
    const res = await tool.handler({} as never, { frameId: 11 });
    expect((res as { scopes: Array<{ variables: unknown[] }> }).scopes[0]?.variables).to.deep.equal([
      { name: 'X', value: '1', variablesReference: 0 },
    ]);
  });

  it('cql_debug_evaluate requires expression', async () => {
    const session = makeFakeSession();
    const tool = findTool('cql_debug_evaluate', session);
    let threw = false;
    try {
      await tool.handler({} as never, {});
    } catch (err) {
      threw = true;
      expect((err as Error).message).to.match(/Missing required argument: expression/);
    }
    expect(threw).to.equal(true);
  });

  it('cql_debug_stop sets active=false', async () => {
    const session = makeFakeSession();
    session.isActive = true;
    const tool = findTool('cql_debug_stop', session);
    const res = await tool.handler({} as never, {});
    expect(res).to.deep.equal({ active: false });
    expect(session.isActive).to.equal(false);
  });

  describe('stepGranularity validation (cql_debug_start)', () => {
    it('accepts "ast"', async () => {
      const session = makeFakeSession();
      const tool = findTool('cql_debug_start', session);
      await tool.handler({} as never, { cqlFile: '/x/lib.cql', stepGranularity: 'ast' });
      expect(session.startedWith?.stepGranularity).to.equal('ast');
    });

    it('accepts "cql"', async () => {
      const session = makeFakeSession();
      const tool = findTool('cql_debug_start', session);
      await tool.handler({} as never, { cqlFile: '/x/lib.cql', stepGranularity: 'cql' });
      expect(session.startedWith?.stepGranularity).to.equal('cql');
    });

    it('omits stepGranularity when undefined', async () => {
      const session = makeFakeSession();
      const tool = findTool('cql_debug_start', session);
      await tool.handler({} as never, { cqlFile: '/x/lib.cql' });
      expect(session.startedWith?.stepGranularity).to.equal(undefined);
    });

    it('rejects an unrecognized string explicitly', async () => {
      const session = makeFakeSession();
      const tool = findTool('cql_debug_start', session);
      let threw = false;
      try {
        await tool.handler({} as never, { cqlFile: '/x/lib.cql', stepGranularity: 'atomic' });
      } catch (err) {
        threw = true;
        expect((err as Error).message).to.match(/stepGranularity must be 'cql' or 'ast'/);
        expect((err as Error).message).to.include('atomic');
      }
      expect(threw).to.equal(true);
      expect(session.startedWith).to.equal(null);
    });

    it('rejects a non-string type', async () => {
      const session = makeFakeSession();
      const tool = findTool('cql_debug_start', session);
      let threw = false;
      try {
        await tool.handler(
          {} as never,
          { cqlFile: '/x/lib.cql', stepGranularity: 42 as unknown as string },
        );
      } catch (err) {
        threw = true;
        expect((err as Error).message).to.match(/stepGranularity must be a string/);
      }
      expect(threw).to.equal(true);
    });
  });
});