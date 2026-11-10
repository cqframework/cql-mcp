import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ensureWorkspaceFolder,
  igRootOf,
  isUnder,
  pathKey,
  projectRootOf,
  registerWorkspaceFolder,
  syncCqlDocument,
  type NotificationSink,
} from '../../../src/lsp/documentSync.js';
import { pathToUri, uriToPath } from '../../../src/workspace/paths.js';

class FakeClient implements NotificationSink {
  sent: Array<{ method: string; params: any }> = [];
  sendNotification(method: string, params?: unknown): void {
    this.sent.push({ method, params });
  }
  methods(): string[] {
    return this.sent.map((s) => s.method);
  }
}

describe('documentSync', () => {
  describe('projectRootOf', () => {
    // | Form                  | Input                              | Expected        |
    // | --------------------- | ---------------------------------- | --------------- |
    // | macOS / Linux         | /a/proj/input/cql/X.cql            | /a/proj         |
    // | Windows backslash     | C:\a\proj\input\cql\X.cql          | C:\a\proj       |
    // | Windows forward slash | C:/a/proj/input/cql/X.cql          | C:/a/proj       |
    // | No input/cql layout   | /tmp/scratch/X.cql (and Windows)   | the file's dir  |
    it('returns the directory above input/cql on POSIX paths', () => {
      expect(projectRootOf('/a/proj/input/cql/X.cql')).to.equal('/a/proj');
    });
    it('returns the directory above input/cql on Windows backslash paths', () => {
      expect(projectRootOf('C:\\a\\proj\\input\\cql\\X.cql')).to.equal('C:\\a\\proj');
    });
    it('returns the directory above input/cql on Windows forward-slash paths', () => {
      expect(projectRootOf('C:/a/proj/input/cql/X.cql')).to.equal('C:/a/proj');
    });
    it('uses the innermost input/cql when nested', () => {
      expect(projectRootOf('/a/input/cql/b/input/cql/X.cql')).to.equal('/a/input/cql/b');
    });
    it("falls back to the file's directory without an input/cql layout", () => {
      expect(projectRootOf('/tmp/scratch/X.cql')).to.equal('/tmp/scratch');
      expect(projectRootOf('C:\\tmp\\scratch\\X.cql')).to.equal('C:\\tmp\\scratch');
      expect(projectRootOf('C:/tmp/scratch/X.cql')).to.equal('C:/tmp/scratch');
    });
  });

  describe('igRootOf', () => {
    // `exists` is injected so every path form runs on any host; it reports which ig.ini paths exist.
    //
    // | Form                  | Input                          | ig.ini at        | Expected   |
    // | --------------------- | ------------------------------ | ---------------- | ---------- |
    // | macOS / Linux         | /a/proj/input/cql/X.cql        | /a/proj          | /a/proj    |
    // | Windows backslash     | C:\a\proj\input\cql\X.cql      | C:\a\proj        | C:\a\proj  |
    // | Windows forward slash | C:/a/proj/input/cql/X.cql      | C:/a/proj        | C:/a/proj  |
    // | Ancestor ig.ini       | /a/ws/proj/input/cql/X.cql     | /a/ws            | /a/ws/proj |
    // | No ig.ini anywhere    | /a/proj/input/cql/X.cql        | (none)           | null       |
    // | No input/cql layout   | /a/proj/temp/probe/X.cql       | /a/proj          | null       |
    // | Probe with input/cql  | /a/proj/temp/probe/input/cql/X.cql | /a/proj      | /a/proj/temp/probe |
    const only = (...present: string[]) => (p: string) => present.includes(p);

    it('returns the project root when ig.ini sits beside input/ on POSIX paths', () => {
      expect(igRootOf('/a/proj/input/cql/X.cql', only('/a/proj/ig.ini'))).to.equal('/a/proj');
    });
    it('returns the project root on Windows backslash paths', () => {
      expect(igRootOf('C:\\a\\proj\\input\\cql\\X.cql', only('C:\\a\\proj\\ig.ini'))).to.equal('C:\\a\\proj');
    });
    it('returns the project root on Windows forward-slash paths', () => {
      expect(igRootOf('C:/a/proj/input/cql/X.cql', only('C:/a/proj/ig.ini'))).to.equal('C:/a/proj');
    });
    it('returns the project root when ig.ini is in an ancestor (multi-project layout)', () => {
      expect(igRootOf('/a/ws/proj/input/cql/X.cql', only('/a/ws/ig.ini'))).to.equal('/a/ws/proj');
      expect(igRootOf('C:\\ws\\proj\\input\\cql\\X.cql', only('C:\\ig.ini'))).to.equal('C:\\ws\\proj');
      expect(igRootOf('/ws/proj/input/cql/X.cql', only('/ig.ini'))).to.equal('/ws/proj');
    });
    it('does not look inside input/ (the server starts its search at the project root)', () => {
      expect(igRootOf('/a/proj/input/cql/X.cql', only('/a/proj/input/ig.ini'))).to.equal(null);
    });
    it('returns null when no ig.ini exists at or above the project root', () => {
      expect(igRootOf('/a/proj/input/cql/X.cql', only())).to.equal(null);
      expect(igRootOf('C:/a/proj/input/cql/X.cql', only())).to.equal(null);
    });
    it('returns null without an input/cql layout, even inside an IG (scratch probes)', () => {
      expect(igRootOf('/a/proj/temp/probe/X.cql', only('/a/proj/ig.ini'))).to.equal(null);
      expect(igRootOf('C:\\a\\proj\\temp\\probe\\X.cql', only('C:\\a\\proj\\ig.ini'))).to.equal(null);
    });
    it("gives a probe folder with its own input/cql the enclosing IG's context", () => {
      // The probe root is sent as rootDir; the server then finds the enclosing IG's ig.ini above it.
      expect(igRootOf('/a/proj/temp/probe/input/cql/X.cql', only('/a/proj/ig.ini'))).to.equal('/a/proj/temp/probe');
      expect(igRootOf('C:\\a\\proj\\temp\\probe\\input\\cql\\X.cql', only('C:\\a\\proj\\ig.ini'))).to.equal(
        'C:\\a\\proj\\temp\\probe',
      );
      expect(igRootOf('C:/a/proj/temp/probe/input/cql/X.cql', only('C:/a/proj/ig.ini'))).to.equal('C:/a/proj/temp/probe');
    });
  });

  describe('isUnder / pathKey', () => {
    it('matches a file inside a folder on POSIX', () => {
      expect(isUnder('/a/proj/input/cql/X.cql', '/a/proj')).to.equal(true);
      expect(isUnder('/a/proj/input/cql/X.cql', '/a/proj/')).to.equal(true);
    });
    it('does not match a sibling folder that shares a prefix', () => {
      expect(isUnder('/a/project2/X.cql', '/a/proj')).to.equal(false);
    });
    it('treats Windows backslash and forward-slash forms as the same path', () => {
      expect(isUnder('C:\\a\\proj\\input\\cql\\X.cql', 'C:/a/proj')).to.equal(true);
      expect(isUnder('C:/a/proj/input/cql/X.cql', 'C:\\a\\proj')).to.equal(true);
    });
    it('ignores drive-letter case', () => {
      expect(isUnder('c:\\a\\proj\\X.cql', 'C:\\a\\proj')).to.equal(true);
      expect(pathKey('C:\\a\\b\\')).to.equal('c:/a/b');
    });
  });

  describe('pathKey platform table', () => {
    // pathKey(input, platform, cwd) must give the same key on every host for each row.
    //
    // | Input                           | Platform | cwd        | Key                      |
    // | ------------------------------- | -------- | ---------- | ------------------------ |
    // | /a/proj/X.cql                   | linux    | /ws        | /a/proj/X.cql            |
    // | C:\a\proj\X.cql                 | win32    | C:\ws      | c:/a/proj/X.cql          |
    // | C:/a/proj/X.cql                 | win32    | C:\ws      | c:/a/proj/X.cql          |
    // | C:\a\proj\X.cql                 | linux    | /ws        | c:/a/proj/X.cql          |
    // | C:/a/proj/X.cql                 | darwin   | /ws        | c:/a/proj/X.cql          |
    // | input/cql/X.cql (relative)      | win32    | C:\ws      | c:/ws/input/cql/X.cql    |
    // | input/cql/X.cql (relative)      | linux    | /ws        | /ws/input/cql/X.cql      |
    // | /a/proj/X.cql (POSIX form)      | win32    | C:\ws      | c:/a/proj/X.cql          |
    // | \\\\srv\\share\\X.cql (UNC)     | win32    | C:\ws      | //srv/share/X.cql        |
    const rows: Array<[string, NodeJS.Platform, string, string]> = [
      ['/a/proj/X.cql', 'linux', '/ws', '/a/proj/X.cql'],
      ['C:\\a\\proj\\X.cql', 'win32', 'C:\\ws', 'c:/a/proj/X.cql'],
      ['C:/a/proj/X.cql', 'win32', 'C:\\ws', 'c:/a/proj/X.cql'],
      ['C:\\a\\proj\\X.cql', 'linux', '/ws', 'c:/a/proj/X.cql'],
      ['C:/a/proj/X.cql', 'darwin', '/ws', 'c:/a/proj/X.cql'],
      ['input/cql/X.cql', 'win32', 'C:\\ws', 'c:/ws/input/cql/X.cql'],
      ['input/cql/X.cql', 'linux', '/ws', '/ws/input/cql/X.cql'],
      ['/a/proj/X.cql', 'win32', 'C:\\ws', 'c:/a/proj/X.cql'],
      ['\\\\srv\\share\\X.cql', 'win32', 'C:\\ws', '//srv/share/X.cql'],
    ];
    for (const [input, platform, cwd, expected] of rows) {
      it(`${JSON.stringify(input)} on ${platform} (cwd ${cwd}) -> ${expected}`, () => {
        expect(pathKey(input, platform, cwd)).to.equal(expected);
      });
    }

    // The bug in one line: a key built from a path must equal the key of the same path coming
    // back from a file:// URI (which is how incoming diagnostics are keyed). It must hold on the
    // current host for relative, POSIX-form and Windows-form inputs.
    const roundTrips = ['input/cql/X.cql', '/a/proj/X.cql', 'C:\\a\\proj\\X.cql', 'C:/a/proj/X.cql'];
    for (const input of roundTrips) {
      it(`pathKey(uriToPath(pathToUri(${JSON.stringify(input)}))) equals pathKey(input) on this host`, () => {
        expect(pathKey(uriToPath(pathToUri(input)))).to.equal(pathKey(input));
      });
    }

    it('keys agree for isUnder with a relative file and an absolute folder on this host', () => {
      const rel = path.join('input', 'cql', 'X.cql');
      expect(isUnder(rel, process.cwd())).to.equal(true);
      expect(isUnder(path.resolve(rel), process.cwd())).to.equal(true);
    });
  });

  describe('ensureWorkspaceFolder', () => {
    it('adds nothing when a registered folder already contains the file', () => {
      const c = new FakeClient();
      registerWorkspaceFolder(c, '/ws');
      expect(ensureWorkspaceFolder(c, '/ws/input/cql/X.cql')).to.equal(null);
      expect(c.sent).to.have.length(0);
    });
    it("adds the file's project root when no folder contains it, once", () => {
      const c = new FakeClient();
      registerWorkspaceFolder(c, '/ws');
      expect(ensureWorkspaceFolder(c, '/tmp/probe/input/cql/A.cql')).to.equal('/tmp/probe');
      expect(ensureWorkspaceFolder(c, '/tmp/probe/input/cql/B.cql')).to.equal(null);
      expect(c.methods()).to.deep.equal(['workspace/didChangeWorkspaceFolders']);
      const added = c.sent[0]!.params.event.added;
      expect(added).to.deep.equal([{ uri: pathToUri('/tmp/probe'), name: 'probe' }]);
      expect(c.sent[0]!.params.event.removed).to.deep.equal([]);
    });
    it('adds a Windows project root with a file URI', () => {
      const c = new FakeClient();
      ensureWorkspaceFolder(c, 'C:\\tmp\\probe\\input\\cql\\A.cql');
      expect(c.sent[0]!.params.event.added[0].uri).to.equal(pathToUri('C:\\tmp\\probe'));
    });
    it('keeps state per client', () => {
      const a = new FakeClient();
      const b = new FakeClient();
      ensureWorkspaceFolder(a, '/tmp/x/A.cql');
      ensureWorkspaceFolder(b, '/tmp/x/A.cql');
      expect(a.sent).to.have.length(1);
      expect(b.sent).to.have.length(1);
    });
  });

  describe('syncCqlDocument', () => {
    let dir: string;
    let file: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cql-sync-'));
      file = path.join(dir, 'Probe.cql');
      fs.writeFileSync(file, 'library Probe\n\ndefine "A": 1\n');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('sends didOpen with version 1 the first time', () => {
      const c = new FakeClient();
      expect(syncCqlDocument(c, file)).to.equal('opened');
      expect(c.methods()).to.deep.equal(['textDocument/didOpen']);
      expect(c.sent[0]!.params.textDocument).to.deep.include({
        uri: pathToUri(file),
        languageId: 'cql',
        version: 1,
        text: 'library Probe\n\ndefine "A": 1\n',
      });
    });

    it('sends nothing when the text has not changed', () => {
      const c = new FakeClient();
      syncCqlDocument(c, file);
      expect(syncCqlDocument(c, file)).to.equal('unchanged');
      expect(c.methods()).to.deep.equal(['textDocument/didOpen']);
    });

    it('sends didChange with the next version and the full text after an edit', () => {
      // This is the stale-ELM fix: the server's compile cache is invalidated on didChange,
      // not on a repeated didOpen.
      const c = new FakeClient();
      syncCqlDocument(c, file);
      fs.writeFileSync(file, 'library Probe\n\ndefine "A": 2\n');
      expect(syncCqlDocument(c, file)).to.equal('changed');
      fs.writeFileSync(file, 'library Probe\n\ndefine "A": 3\n');
      expect(syncCqlDocument(c, file)).to.equal('changed');
      expect(c.methods()).to.deep.equal([
        'textDocument/didOpen',
        'textDocument/didChange',
        'textDocument/didChange',
      ]);
      expect(c.sent[1]!.params).to.deep.equal({
        textDocument: { uri: pathToUri(file), version: 2 },
        contentChanges: [{ text: 'library Probe\n\ndefine "A": 2\n' }],
      });
      expect(c.sent[2]!.params.textDocument.version).to.equal(3);
    });

    it('starts again with didOpen on a new client (a respawned server)', () => {
      const first = new FakeClient();
      syncCqlDocument(first, file);
      const second = new FakeClient();
      expect(syncCqlDocument(second, file)).to.equal('opened');
    });

    it('uses supplied text instead of reading the file', () => {
      const c = new FakeClient();
      syncCqlDocument(c, file, 'library Probe\n\ndefine "B": 9\n');
      expect(c.sent[0]!.params.textDocument.text).to.equal('library Probe\n\ndefine "B": 9\n');
    });
  });
});
