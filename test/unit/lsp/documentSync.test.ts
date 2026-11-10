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
import { onPosix, onWindows } from '../../helpers/platform.js';

class FakeClient implements NotificationSink {
  sent: Array<{ method: string; params: any }> = [];
  sendNotification(method: string, params?: unknown): void {
    this.sent.push({ method, params });
  }
  methods(): string[] {
    return this.sent.map((s) => s.method);
  }
}

// ADR-0003: paths follow the host's rules and each CI runner tests its own native forms. Portable
// tests build inputs with path.join under os.tmpdir(); hard-coded native paths live in
// onPosix / onWindows blocks, each with a counterpart for the other platform.
describe('documentSync', () => {
  const base = path.join(os.tmpdir(), 'ws');
  const j = (...segments: string[]) => path.join(base, ...segments);
  /** `exists` stub reporting which paths are present. */
  const only = (...present: string[]) => (p: string) => present.includes(p);

  describe('projectRootOf', () => {
    // | Host          | Input                      | Expected        |
    // | ------------- | -------------------------- | --------------- |
    // | macOS / Linux | /a/proj/input/cql/X.cql    | /a/proj         |
    // | Windows       | C:\a\proj\input\cql\X.cql  | C:\a\proj       |
    // | Windows       | C:/a/proj/input/cql/X.cql  | C:\a\proj (normalized) |
    it('returns the directory above input/cql', () => {
      expect(projectRootOf(j('a', 'proj', 'input', 'cql', 'X.cql'))).to.equal(j('a', 'proj'));
    });
    it('uses the innermost input/cql when nested', () => {
      expect(projectRootOf(j('a', 'input', 'cql', 'b', 'input', 'cql', 'X.cql'))).to.equal(j('a', 'input', 'cql', 'b'));
    });
    it("falls back to the file's directory without an input/cql layout", () => {
      expect(projectRootOf(j('tmp', 'scratch', 'X.cql'))).to.equal(j('tmp', 'scratch'));
    });
    onPosix('native forms', () => {
      it('/a/proj/input/cql/X.cql -> /a/proj', () => {
        expect(projectRootOf('/a/proj/input/cql/X.cql')).to.equal('/a/proj');
      });
      it('/input/cql/X.cql -> /', () => {
        expect(projectRootOf('/input/cql/X.cql')).to.equal('/');
      });
      it('/tmp/scratch/X.cql -> /tmp/scratch', () => {
        expect(projectRootOf('/tmp/scratch/X.cql')).to.equal('/tmp/scratch');
      });
    });
    onWindows('native forms', () => {
      it('C:\\a\\proj\\input\\cql\\X.cql -> C:\\a\\proj', () => {
        expect(projectRootOf('C:\\a\\proj\\input\\cql\\X.cql')).to.equal('C:\\a\\proj');
      });
      it('C:/a/proj/input/cql/X.cql -> C:\\a\\proj', () => {
        expect(projectRootOf('C:/a/proj/input/cql/X.cql')).to.equal('C:\\a\\proj');
      });
      it('C:\\input\\cql\\X.cql -> C:\\', () => {
        expect(projectRootOf('C:\\input\\cql\\X.cql')).to.equal('C:\\');
      });
      it('C:\\tmp\\scratch\\X.cql -> C:\\tmp\\scratch', () => {
        expect(projectRootOf('C:\\tmp\\scratch\\X.cql')).to.equal('C:\\tmp\\scratch');
      });
    });
  });

  describe('igRootOf', () => {
    // `exists` is injected; it reports which ig.ini paths exist.
    //
    // | Case                  | Input                           | ig.ini at   | Expected           |
    // | --------------------- | ------------------------------- | ----------- | ------------------ |
    // | beside input/         | <ws>/a/proj/input/cql/X.cql     | <ws>/a/proj | <ws>/a/proj        |
    // | ancestor ig.ini       | <ws>/a/ws/proj/input/cql/X.cql  | <ws>/a/ws   | <ws>/a/ws/proj     |
    // | none anywhere         | <ws>/a/proj/input/cql/X.cql     | (none)      | null               |
    // | no input/cql layout   | <ws>/a/proj/temp/probe/X.cql    | <ws>/a/proj | null               |
    // | probe with input/cql  | <ws>/a/proj/temp/probe/input/cql/X.cql | <ws>/a/proj | <ws>/a/proj/temp/probe |
    it('returns the project root when ig.ini sits beside input/', () => {
      expect(igRootOf(j('a', 'proj', 'input', 'cql', 'X.cql'), only(j('a', 'proj', 'ig.ini')))).to.equal(j('a', 'proj'));
    });
    it('returns the project root when ig.ini is in an ancestor (multi-project layout)', () => {
      expect(igRootOf(j('a', 'ws', 'proj', 'input', 'cql', 'X.cql'), only(j('a', 'ws', 'ig.ini')))).to.equal(
        j('a', 'ws', 'proj'),
      );
    });
    it('does not look inside input/ (the server starts its search at the project root)', () => {
      expect(igRootOf(j('a', 'proj', 'input', 'cql', 'X.cql'), only(j('a', 'proj', 'input', 'ig.ini')))).to.equal(null);
    });
    it('returns null when no ig.ini exists at or above the project root', () => {
      expect(igRootOf(j('a', 'proj', 'input', 'cql', 'X.cql'), only())).to.equal(null);
    });
    it('returns null without an input/cql layout, even inside an IG (scratch probes)', () => {
      expect(igRootOf(j('a', 'proj', 'temp', 'probe', 'X.cql'), only(j('a', 'proj', 'ig.ini')))).to.equal(null);
    });
    it("gives a probe folder with its own input/cql the enclosing IG's context", () => {
      // The probe root is sent as rootDir; the server then finds the enclosing IG's ig.ini above it.
      expect(
        igRootOf(j('a', 'proj', 'temp', 'probe', 'input', 'cql', 'X.cql'), only(j('a', 'proj', 'ig.ini'))),
      ).to.equal(j('a', 'proj', 'temp', 'probe'));
    });
    onPosix('native forms', () => {
      it('/a/proj/input/cql/X.cql with /a/proj/ig.ini -> /a/proj', () => {
        expect(igRootOf('/a/proj/input/cql/X.cql', only('/a/proj/ig.ini'))).to.equal('/a/proj');
      });
      it('/ws/proj/input/cql/X.cql with /ig.ini at the file-system root -> /ws/proj', () => {
        expect(igRootOf('/ws/proj/input/cql/X.cql', only('/ig.ini'))).to.equal('/ws/proj');
      });
    });
    onWindows('native forms', () => {
      it('C:\\a\\proj\\input\\cql\\X.cql with C:\\a\\proj\\ig.ini -> C:\\a\\proj', () => {
        expect(igRootOf('C:\\a\\proj\\input\\cql\\X.cql', only('C:\\a\\proj\\ig.ini'))).to.equal('C:\\a\\proj');
      });
      it('C:/a/proj/input/cql/X.cql with C:\\a\\proj\\ig.ini -> C:\\a\\proj', () => {
        expect(igRootOf('C:/a/proj/input/cql/X.cql', only('C:\\a\\proj\\ig.ini'))).to.equal('C:\\a\\proj');
      });
      it('C:\\ws\\proj\\input\\cql\\X.cql with C:\\ig.ini at the drive root -> C:\\ws\\proj', () => {
        expect(igRootOf('C:\\ws\\proj\\input\\cql\\X.cql', only('C:\\ig.ini'))).to.equal('C:\\ws\\proj');
      });
      it('returns null without an ig.ini', () => {
        expect(igRootOf('C:/a/proj/input/cql/X.cql', only())).to.equal(null);
      });
    });
  });

  describe('isUnder / pathKey', () => {
    it('matches a file inside a folder, with or without a trailing separator', () => {
      expect(isUnder(j('a', 'proj', 'input', 'cql', 'X.cql'), j('a', 'proj'))).to.equal(true);
      expect(isUnder(j('a', 'proj', 'input', 'cql', 'X.cql'), j('a', 'proj') + path.sep)).to.equal(true);
    });
    it('does not match a sibling folder that shares a prefix', () => {
      expect(isUnder(j('a', 'project2', 'X.cql'), j('a', 'proj'))).to.equal(false);
    });
    it('matches a relative file against an absolute folder', () => {
      const rel = path.join('input', 'cql', 'X.cql');
      expect(isUnder(rel, process.cwd())).to.equal(true);
      expect(isUnder(path.resolve(rel), process.cwd())).to.equal(true);
    });
    onPosix('native forms', () => {
      it('/a/proj/input/cql/X.cql is under /a/proj and /a/proj/', () => {
        expect(isUnder('/a/proj/input/cql/X.cql', '/a/proj')).to.equal(true);
        expect(isUnder('/a/proj/input/cql/X.cql', '/a/proj/')).to.equal(true);
      });
      it('pathKey keeps the root and strips a trailing slash', () => {
        expect(pathKey('/')).to.equal('/');
        expect(pathKey('/a/b/')).to.equal('/a/b');
      });
    });
    onWindows('native forms', () => {
      it('treats backslash and forward-slash forms as the same path', () => {
        expect(isUnder('C:\\a\\proj\\input\\cql\\X.cql', 'C:/a/proj')).to.equal(true);
        expect(isUnder('C:/a/proj/input/cql/X.cql', 'C:\\a\\proj')).to.equal(true);
      });
      it('ignores drive-letter case and trailing separators; keeps the drive root', () => {
        expect(isUnder('c:\\a\\proj\\X.cql', 'C:\\a\\proj')).to.equal(true);
        expect(pathKey('C:\\a\\b\\')).to.equal('c:/a/b');
        expect(pathKey('C:\\')).to.equal('c:/');
      });
    });
  });

  describe('pathKey platform table', () => {
    // pathKey(input, platform, cwd) picks path.win32 or path.posix by `platform` only, so every
    // row runs on every host (a test seam, not product behaviour).
    //
    // | Input                         | Platform | cwd      | Key                              |
    // | ----------------------------- | -------- | -------- | -------------------------------- |
    // | /a/proj/X.cql                 | linux    | /ws      | /a/proj/X.cql                    |
    // | input/cql/X.cql (relative)    | linux    | /ws      | /ws/input/cql/X.cql              |
    // | /a/proj/ (trailing slash)     | darwin   | /ws      | /a/proj                          |
    // | /                             | linux    | /ws      | /                                |
    // | C:\a\proj\X.cql (a filename)  | linux    | /ws      | /ws/C:\a\proj\X.cql              |
    // | C:\a\proj\X.cql                | win32    | C:\ws    | c:/a/proj/X.cql                  |
    // | C:/a/proj/X.cql               | win32    | C:\ws    | c:/a/proj/X.cql                  |
    // | input/cql/X.cql (relative)    | win32    | C:\ws    | c:/ws/input/cql/X.cql            |
    // | /a/proj/X.cql (drive-relative)| win32    | C:\ws    | c:/a/proj/X.cql                  |
    // | C:\                           | win32    | C:\ws    | c:/                              |
    // | \\srv\share\X.cql (UNC)       | win32    | C:\ws    | //srv/share/X.cql                |
    const rows: Array<[string, NodeJS.Platform, string, string]> = [
      ['/a/proj/X.cql', 'linux', '/ws', '/a/proj/X.cql'],
      ['input/cql/X.cql', 'linux', '/ws', '/ws/input/cql/X.cql'],
      ['/a/proj/', 'darwin', '/ws', '/a/proj'],
      ['/', 'linux', '/ws', '/'],
      // On POSIX a backslash is an ordinary filename character (ADR-0003).
      ['C:\\a\\proj\\X.cql', 'linux', '/ws', '/ws/C:\\a\\proj\\X.cql'],
      ['C:\\a\\proj\\X.cql', 'win32', 'C:\\ws', 'c:/a/proj/X.cql'],
      ['C:/a/proj/X.cql', 'win32', 'C:\\ws', 'c:/a/proj/X.cql'],
      ['input/cql/X.cql', 'win32', 'C:\\ws', 'c:/ws/input/cql/X.cql'],
      ['/a/proj/X.cql', 'win32', 'C:\\ws', 'c:/a/proj/X.cql'],
      ['C:\\', 'win32', 'C:\\ws', 'c:/'],
      ['\\\\srv\\share\\X.cql', 'win32', 'C:\\ws', '//srv/share/X.cql'],
    ];
    for (const [input, platform, cwd, expected] of rows) {
      it(`${JSON.stringify(input)} on ${platform} (cwd ${cwd}) -> ${expected}`, () => {
        expect(pathKey(input, platform, cwd)).to.equal(expected);
      });
    }

    // The Windows-host bug in one line: a key built from a path must equal the key of the same
    // path coming back from a file:// URI (how incoming diagnostics are keyed).
    it('pathKey(uriToPath(pathToUri(p))) equals pathKey(p) for relative and absolute paths', () => {
      for (const input of [path.join('input', 'cql', 'X.cql'), j('a', 'proj', 'X.cql')]) {
        expect(pathKey(uriToPath(pathToUri(input)))).to.equal(pathKey(input));
      }
    });
    onWindows('native round trips', () => {
      it('backslash and forward-slash inputs round-trip', () => {
        for (const input of ['C:\\a\\proj\\X.cql', 'C:/a/proj/X.cql']) {
          expect(pathKey(uriToPath(pathToUri(input)))).to.equal(pathKey(input));
        }
      });
      // The language server may send either drive-letter form; both must reach the same key.
      it('file:///C:/... and file:///c%3A/... give the same key', () => {
        const a = pathKey(uriToPath('file:///C:/a/proj/X.cql'));
        const b = pathKey(uriToPath('file:///c%3A/a/proj/X.cql'));
        expect(a).to.equal('c:/a/proj/X.cql');
        expect(b).to.equal(a);
      });
    });
    onPosix('native round trips', () => {
      it('an absolute POSIX path round-trips through a URI', () => {
        expect(pathKey(uriToPath(pathToUri('/a/proj/X.cql')))).to.equal('/a/proj/X.cql');
      });
    });
  });

  describe('ensureWorkspaceFolder', () => {
    it('adds nothing when a registered folder already contains the file', () => {
      const c = new FakeClient();
      registerWorkspaceFolder(c, j());
      expect(ensureWorkspaceFolder(c, j('input', 'cql', 'X.cql'))).to.equal(null);
      expect(c.sent).to.have.length(0);
    });
    it("adds the file's project root when no folder contains it, once", () => {
      const c = new FakeClient();
      registerWorkspaceFolder(c, j());
      const probe = path.join(os.tmpdir(), 'probe-x');
      expect(ensureWorkspaceFolder(c, path.join(probe, 'input', 'cql', 'A.cql'))).to.equal(probe);
      expect(ensureWorkspaceFolder(c, path.join(probe, 'input', 'cql', 'B.cql'))).to.equal(null);
      expect(c.methods()).to.deep.equal(['workspace/didChangeWorkspaceFolders']);
      const added = c.sent[0]!.params.event.added;
      expect(added).to.deep.equal([{ uri: pathToUri(probe), name: 'probe-x' }]);
      expect(c.sent[0]!.params.event.removed).to.deep.equal([]);
    });
    it('keeps state per client', () => {
      const a = new FakeClient();
      const b = new FakeClient();
      const file = path.join(os.tmpdir(), 'tmp-x', 'A.cql');
      ensureWorkspaceFolder(a, file);
      ensureWorkspaceFolder(b, file);
      expect(a.sent).to.have.length(1);
      expect(b.sent).to.have.length(1);
    });
    onPosix('native forms', () => {
      it('adds /tmp/probe with its file URI', () => {
        const c = new FakeClient();
        ensureWorkspaceFolder(c, '/tmp/probe/input/cql/A.cql');
        expect(c.sent[0]!.params.event.added[0]).to.deep.equal({ uri: 'file:///tmp/probe', name: 'probe' });
      });
    });
    onWindows('native forms', () => {
      it('adds C:\\tmp\\probe (backslash input) with its file URI', () => {
        const c = new FakeClient();
        ensureWorkspaceFolder(c, 'C:\\tmp\\probe\\input\\cql\\A.cql');
        expect(c.sent[0]!.params.event.added[0]).to.deep.equal({ uri: 'file:///C:/tmp/probe', name: 'probe' });
      });
      it('treats forward-slash input as the same folder', () => {
        const c = new FakeClient();
        registerWorkspaceFolder(c, 'C:\\tmp\\probe');
        expect(ensureWorkspaceFolder(c, 'C:/tmp/probe/input/cql/A.cql')).to.equal(null);
      });
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
