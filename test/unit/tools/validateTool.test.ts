import { expect } from 'chai';
import * as path from 'node:path';
import { DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { validateTool } from '../../../src/tools/validateTool.js';
import type { McpContext } from '../../../src/tools/defs.js';
import { fixedRuntime } from '../../helpers/fixedRuntime.js';
import { invalidArgNames } from '../../helpers/toolsContract.js';

describe('tools/validateTool', () => {
  it('requires cqlFile (validated by the schema; see server.test.ts for the isError result)', () => {
    expect(invalidArgNames(validateTool, {})).to.deep.equal(['cqlFile']);
    expect(invalidArgNames(validateTool, { cqlFile: '' })).to.deep.equal(['cqlFile']);
  });

  it('throws an error if file does not exist and content is not provided', async () => {
    let error: Error | null = null;
    try {
      await validateTool.handler({} as McpContext, { cqlFile: '/does/not/exist/file.cql' });
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).to.include('CQL file not found');
  });

  it('validates in-memory content using mock LSP client', async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const mockClient = {
      sendNotification: (method: string, params: unknown) => {
        notifications.push({ method, params });
      },
      waitForDiagnostics: async () => [
        {
          message: 'Unknown identifier "foo"',
          severity: DiagnosticSeverity.Error,
          range: { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } },
          code: 'ELM-001',
        },
        {
          message: 'Deprecated syntax',
          severity: DiagnosticSeverity.Warning,
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
        },
      ],
    };

    const mockProcess = {
      ensureReady: async () => {},
      lspClient: mockClient,
      executeCommand: async () => '{}',
    };

    const mockContext: McpContext = {
      process: mockProcess as any,
      debugSession: {} as any,
      runtime: fixedRuntime('/java', '/jar'),
      workspaceRoot: '/workspace',
    };

    const result = (await validateTool.handler(mockContext, {
      cqlFile: '/workspace/virtual.cql',
      content: 'library Virtual version \'1.0.0\'\ndefine "X": foo\n',
    })) as any;

    expect(result.valid).to.be.false;
    expect(result.errorCount).to.equal(1);
    expect(result.warningCount).to.equal(1);
    expect(result.diagnostics).to.have.length(2);
    expect(result.diagnostics[0]).to.deep.equal({
      severity: 'error',
      message: 'Unknown identifier "foo"',
      range: { start: { line: 3, character: 4 }, end: { line: 3, character: 7 } },
      code: 'ELM-001',
    });
  });

  it('merges VIEW_ELM errors into diagnostics when not captured in publishDiagnostics', async () => {
    const mockClient = {
      sendNotification: () => {},
      waitForDiagnostics: async () => [],
    };

    const mockProcess = {
      ensureReady: async () => {},
      lspClient: mockClient,
      executeCommand: async () => {
        throw new Error('Fatal compilation crash in ANTLR parser');
      },
    };

    const mockContext: McpContext = {
      process: mockProcess as any,
      debugSession: {} as any,
      runtime: fixedRuntime('/java', '/jar'),
      workspaceRoot: '/workspace',
    };

    const result = (await validateTool.handler(mockContext, {
      cqlFile: '/workspace/broken.cql',
      content: 'invalid cql content %%%',
    })) as any;

    expect(result.valid).to.be.false;
    expect(result.errorCount).to.equal(1);
    expect(result.diagnostics[0]?.message).to.include('Fatal compilation crash in ANTLR parser');
  });
});
