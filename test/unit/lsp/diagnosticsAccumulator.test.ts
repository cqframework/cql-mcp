import { expect } from 'chai';
import { StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-protocol';
import { LspClient } from '../../../src/lsp/lspClient.js';
import { createChannel, createServerConnection } from '../../helpers/channel.js';
import { pathToUri } from '../../../src/workspace/paths.js';
import { onPosix, onWindows } from '../../helpers/platform.js';
import * as os from 'node:os';
import * as path from 'node:path';

describe('lsp/diagnosticsAccumulator', () => {
  let client: LspClient | null = null;
  let serverDispose: (() => void) | null = null;

  afterEach(() => {
    client?.dispose();
    client = null;
    serverDispose?.();
    serverDispose = null;
  });

  it('accumulates publishDiagnostics notifications and clears on empty array', async () => {
    const channel = createChannel();
    const created = LspClient.create(
      new StreamMessageReader(channel.client.read),
      new StreamMessageWriter(channel.client.write),
    );
    client = created.client;
    const server = createServerConnection(channel.server);
    serverDispose = () => server.dispose();

    const testFile = '/test/path/Measure.cql';
    const testUri = pathToUri(testFile);

    expect(client.getDiagnostics(testFile)).to.be.undefined;

    const diag1: Diagnostic = {
      message: 'Syntax error at line 5',
      severity: DiagnosticSeverity.Error,
      range: {
        start: { line: 4, character: 0 },
        end: { line: 4, character: 10 },
      },
    };

    server.sendNotification('textDocument/publishDiagnostics', {
      uri: testUri,
      diagnostics: [diag1],
    });

    const received = await client.waitForDiagnostics(testFile, 500, 20);
    expect(received).to.deep.equal([diag1]);
    expect(client.getDiagnostics(testFile)).to.deep.equal([diag1]);

    // Now send empty array to clear
    server.sendNotification('textDocument/publishDiagnostics', {
      uri: testUri,
      diagnostics: [],
    });

    const cleared = await client.waitForDiagnostics(testFile, 500, 20);
    expect(cleared).to.deep.equal([]);
    expect(client.getDiagnostics(testFile)).to.deep.equal([]);
  });

  it('settles multi-stage diagnostics updates with quiescence timer', async () => {
    const channel = createChannel();
    const created = LspClient.create(
      new StreamMessageReader(channel.client.read),
      new StreamMessageWriter(channel.client.write),
    );
    client = created.client;
    const server = createServerConnection(channel.server);
    serverDispose = () => server.dispose();

    const testFile = '/test/path/Measure2.cql';
    const testUri = pathToUri(testFile);

    const waitPromise = client.waitForDiagnostics(testFile, 1000, 50);

    // Initial stage warning
    server.sendNotification('textDocument/publishDiagnostics', {
      uri: testUri,
      diagnostics: [
        {
          message: 'Parsing...',
          severity: DiagnosticSeverity.Warning,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      ],
    });

    // 20ms later (before 50ms quiescence), final error arrives
    await new Promise((r) => setTimeout(r, 20));
    const finalDiag: Diagnostic = {
      message: 'Type mismatch',
      severity: DiagnosticSeverity.Error,
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
    };
    server.sendNotification('textDocument/publishDiagnostics', {
      uri: testUri,
      diagnostics: [finalDiag],
    });

    const finalResult = await waitPromise;
    expect(finalResult).to.deep.equal([finalDiag]);
  });

  it('resolves with cached or empty array on timeout when no notifications arrive', async () => {
    const channel = createChannel();
    const created = LspClient.create(
      new StreamMessageReader(channel.client.read),
      new StreamMessageWriter(channel.client.write),
    );
    client = created.client;
    const server = createServerConnection(channel.server);
    serverDispose = () => server.dispose();

    const testFile = '/test/path/NoNotifs.cql';
    const result = await client.waitForDiagnostics(testFile, 40, 10);
    expect(result).to.deep.equal([]);
  });

  // Diagnostics arrive keyed by file URI and are looked up by path; both must reach the same key.
  // Each host tests its own native forms (ADR-0003).
  async function setupClient() {
    const channel = createChannel();
    const created = LspClient.create(
      new StreamMessageReader(channel.client.read),
      new StreamMessageWriter(channel.client.write),
    );
    client = created.client;
    const server = createServerConnection(channel.server);
    serverDispose = () => server.dispose();
    return { server, lsp: created.client };
  }
  const diag: Diagnostic = {
    message: 'Path test error',
    severity: DiagnosticSeverity.Error,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  };

  onPosix('native paths', () => {
    it('matches a URI to absolute and relative lookups', async () => {
      const { server, lsp } = await setupClient();
      const file = path.join(os.tmpdir(), 'my-ig', 'input', 'cql', 'Measure.cql');
      server.sendNotification('textDocument/publishDiagnostics', { uri: pathToUri(file), diagnostics: [diag] });

      expect(await lsp.waitForDiagnostics(file, 500, 20)).to.deep.equal([diag]);
      expect(lsp.getDiagnostics(path.relative(process.cwd(), file))).to.deep.equal([diag]);
    });
  });

  onWindows('native paths', () => {
    it('normalizes file URIs and backslash/forward-slash paths across lookups', async () => {
      const { server, lsp } = await setupClient();
      server.sendNotification('textDocument/publishDiagnostics', {
        uri: 'file:///C:/projects/my-ig/input/cql/Measure.cql',
        diagnostics: [diag],
      });

      const received = await lsp.waitForDiagnostics('C:\\projects\\my-ig\\input\\cql\\Measure.cql', 500, 20);
      expect(received).to.deep.equal([diag]);
      // Forward slash and lower-case drive letter.
      expect(lsp.getDiagnostics('c:/projects/my-ig/input/cql/Measure.cql')).to.deep.equal([diag]);
    });

    it('matches a URI with an encoded drive colon (file:///c%3A/...)', async () => {
      const { server, lsp } = await setupClient();
      server.sendNotification('textDocument/publishDiagnostics', {
        uri: 'file:///c%3A/projects/my-ig/input/cql/Measure.cql',
        diagnostics: [diag],
      });

      const received = await lsp.waitForDiagnostics('C:\\projects\\my-ig\\input\\cql\\Measure.cql', 500, 20);
      expect(received).to.deep.equal([diag]);
    });
  });
});
