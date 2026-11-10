import { expect } from 'chai';
import * as os from 'node:os';
import * as path from 'node:path';
import { cacheJarDir, libraryNameOf, pathToUri, runStoreDir, uriToPath } from '../../../src/workspace/paths.js';
import { onPosix, onWindows } from '../../helpers/platform.js';

// ADR-0003: paths follow the host's rules, and each CI runner tests its own native forms.
//
// | Host            | Input forms tested                       | URI                      |
// | --------------- | ---------------------------------------- | ------------------------ |
// | macOS / Linux   | /a/b.cql                                 | file:///a/b.cql          |
// | Windows         | C:\a\b.cql and C:/a/b.cql                | file:///C:/a/b.cql       |
//
// Tests build inputs with path.join / os.tmpdir() where they can; hard-coded native paths live in
// onPosix / onWindows blocks, each with a counterpart for the other platform.
describe('workspace/paths', () => {
  describe('cacheJarDir', () => {
    const saved = process.env.CQL_MCP_JAR_DIR;
    beforeEach(() => {
      delete process.env.CQL_MCP_JAR_DIR;
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.CQL_MCP_JAR_DIR;
      else process.env.CQL_MCP_JAR_DIR = saved;
    });

    it('defaults to ~/.cql-mcp/jars', () => {
      expect(cacheJarDir()).to.equal(path.join(os.homedir(), '.cql-mcp', 'jars'));
    });
    it('builds the default under a given home', () => {
      const home = path.join(os.tmpdir(), 'home-u');
      expect(cacheJarDir({}, home)).to.equal(path.join(home, '.cql-mcp', 'jars'));
    });
    it('honours the CQL_MCP_JAR_DIR override verbatim', () => {
      const dir = path.join(os.tmpdir(), 'jars');
      process.env.CQL_MCP_JAR_DIR = dir;
      expect(cacheJarDir()).to.equal(dir);
      expect(cacheJarDir({ CQL_MCP_JAR_DIR: dir }, '/ignored')).to.equal(dir);
    });

    onPosix('native forms', () => {
      it('/home/u -> /home/u/.cql-mcp/jars', () => {
        expect(cacheJarDir({}, '/home/u')).to.equal('/home/u/.cql-mcp/jars');
      });
    });
    onWindows('native forms', () => {
      it('C:\\Users\\u -> C:\\Users\\u\\.cql-mcp\\jars', () => {
        expect(cacheJarDir({}, 'C:\\Users\\u')).to.equal('C:\\Users\\u\\.cql-mcp\\jars');
      });
      it('C:/Users/u -> C:\\Users\\u\\.cql-mcp\\jars', () => {
        expect(cacheJarDir({}, 'C:/Users/u')).to.equal('C:\\Users\\u\\.cql-mcp\\jars');
      });
    });
  });

  describe('pathToUri / uriToPath', () => {
    it('round-trips a path built with path.join', () => {
      const p = path.join(os.tmpdir(), 'a b', 'measure.cql');
      expect(uriToPath(pathToUri(p))).to.equal(p);
    });
    it('resolves a relative path against the cwd', () => {
      expect(uriToPath(pathToUri(path.join('input', 'cql', 'X.cql')))).to.equal(
        path.resolve('input', 'cql', 'X.cql'),
      );
    });

    // [input, uri, round-trip path]
    onPosix('native forms', () => {
      const cases: Array<[string, string, string]> = [
        ['/Users/a/projects/measure.cql', 'file:///Users/a/projects/measure.cql', '/Users/a/projects/measure.cql'],
        ['/projects/dir', 'file:///projects/dir', '/projects/dir'],
        ['/a b/c.cql', 'file:///a%20b/c.cql', '/a b/c.cql'],
      ];
      for (const [input, expectedUri, expectedPath] of cases) {
        it(`pathToUri('${input}') -> '${expectedUri}'`, () => {
          expect(pathToUri(input)).to.equal(expectedUri);
        });
        it(`uriToPath('${expectedUri}') -> '${expectedPath}'`, () => {
          expect(uriToPath(expectedUri)).to.equal(expectedPath);
        });
      }
      it('a backslash is an ordinary filename character on POSIX', () => {
        expect(path.basename('/a/b\\c.cql')).to.equal('b\\c.cql');
        expect(uriToPath(pathToUri('/a/b\\c.cql'))).to.equal('/a/b\\c.cql');
      });
    });

    onWindows('native forms', () => {
      const cases: Array<[string, string, string]> = [
        ['C:\\Users\\a\\measure.cql', 'file:///C:/Users/a/measure.cql', 'C:\\Users\\a\\measure.cql'],
        ['C:/Users/a/measure.cql', 'file:///C:/Users/a/measure.cql', 'C:\\Users\\a\\measure.cql'],
        ['C:\\projects\\dir', 'file:///C:/projects/dir', 'C:\\projects\\dir'],
      ];
      for (const [input, expectedUri, expectedPath] of cases) {
        it(`pathToUri('${input}') -> '${expectedUri}'`, () => {
          expect(pathToUri(input)).to.equal(expectedUri);
        });
        it(`uriToPath('${expectedUri}') -> '${expectedPath}'`, () => {
          expect(uriToPath(expectedUri)).to.equal(expectedPath);
        });
      }
      // The language server may send either drive-letter form.
      it('uriToPath accepts file:///C:/x/y.cql and file:///c%3A/x/y.cql', () => {
        expect(uriToPath('file:///C:/x/y.cql')).to.equal('C:\\x\\y.cql');
        expect(uriToPath('file:///c%3A/x/y.cql').toLowerCase()).to.equal('c:\\x\\y.cql');
      });
    });
  });

  describe('libraryNameOf', () => {
    it('strips the .cql extension', () => {
      expect(libraryNameOf(path.join(os.tmpdir(), 'b', 'MyLib.cql'))).to.equal('MyLib');
    });
    it('passes through a basename without .cql', () => {
      expect(libraryNameOf(path.join(os.tmpdir(), 'b', 'MyLib'))).to.equal('MyLib');
    });
    onPosix('native forms', () => {
      it('/a/b/MyLib.cql -> MyLib', () => {
        expect(libraryNameOf('/a/b/MyLib.cql')).to.equal('MyLib');
      });
    });
    onWindows('native forms', () => {
      it('C:\\a\\b\\MyLib.cql -> MyLib', () => {
        expect(libraryNameOf('C:\\a\\b\\MyLib.cql')).to.equal('MyLib');
      });
      it('C:/a/b/MyLib.cql -> MyLib', () => {
        expect(libraryNameOf('C:/a/b/MyLib.cql')).to.equal('MyLib');
      });
    });
  });

  describe('runStoreDir', () => {
    it('places runs under <root>/.cql-debug/test-runs', () => {
      const root = path.join(os.tmpdir(), 'project');
      expect(runStoreDir(root)).to.equal(path.join(root, '.cql-debug', 'test-runs'));
    });
    onPosix('native forms', () => {
      it('/work/project', () => {
        expect(runStoreDir('/work/project')).to.equal('/work/project/.cql-debug/test-runs');
      });
    });
    onWindows('native forms', () => {
      it('C:\\work\\project', () => {
        expect(runStoreDir('C:\\work\\project')).to.equal('C:\\work\\project\\.cql-debug\\test-runs');
      });
      it('C:/work/project', () => {
        expect(runStoreDir('C:/work/project')).to.equal('C:\\work\\project\\.cql-debug\\test-runs');
      });
    });
  });
});
