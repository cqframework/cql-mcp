import { expect } from 'chai';
import * as os from 'node:os';
import * as path from 'node:path';
import { cacheJarDir, joinLike, libraryNameOf, pathToUri, runStoreDir, uriToPath } from '../../../src/workspace/paths.js';

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

    // Env override values pass through verbatim on every platform:
    //   macOS/Linux '/opt/jars'   Windows 'C:\\jars'   Windows 'C:/jars'
    it('defaults to ~/.cql-mcp/jars', () => {
      expect(cacheJarDir()).to.equal(path.join(os.homedir(), '.cql-mcp', 'jars'));
    });
    // Home directory per platform form (the env and home are injectable):
    //   /home/u -> /home/u/.cql-mcp/jars   C:\Users\u -> C:\Users\u\.cql-mcp\jars   C:/Users/u -> C:\Users\u\.cql-mcp\jars
    it('builds the default under a given home for each platform form', () => {
      expect(cacheJarDir({}, '/home/u')).to.equal(path.join('/home/u', '.cql-mcp', 'jars'));
      expect(cacheJarDir({}, 'C:\\Users\\u')).to.equal('C:\\Users\\u\\.cql-mcp\\jars');
      expect(cacheJarDir({}, 'C:/Users/u').replace(/\\/g, '/')).to.equal('C:/Users/u/.cql-mcp/jars');
    });
    it('reads the override from the injected env', () => {
      expect(cacheJarDir({ CQL_MCP_JAR_DIR: 'C:/cache' }, '/home/u')).to.equal('C:/cache');
    });
    it('joinLike follows the base convention', () => {
      expect(joinLike('/a/b', 'c')).to.equal(path.join('/a/b', 'c'));
      expect(joinLike('C:\\a', 'c', 'd')).to.equal('C:\\a\\c\\d');
    });
    for (const dir of ['/opt/jars', 'C:\\jars', 'C:/jars']) {
      it(`honours CQL_MCP_JAR_DIR='${dir}'`, () => {
        process.env.CQL_MCP_JAR_DIR = dir;
        expect(cacheJarDir()).to.equal(dir);
      });
    }
  });

  describe('pathToUri / uriToPath', () => {
    // Cross-platform table. Expected URI and round-trip path per input format,
    // independent of the host platform:
    //   input                      uri                           path (round-trip)
    //   macOS/Linux '/a/b.cql'     file:///a/b.cql               /a/b.cql
    //   Windows '\' 'C:\a\b.cql'   file:///C:/a/b.cql            C:\a\b.cql
    //   Windows '/' 'C:/a/b.cql'   file:///C:/a/b.cql            C:\a\b.cql
    const cases: Array<[string, string, string]> = [
      ['/Users/a/projects/measure.cql', 'file:///Users/a/projects/measure.cql', '/Users/a/projects/measure.cql'],
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
  });

  describe('libraryNameOf', () => {
    it('strips the .cql extension', () => {
      expect(libraryNameOf('/a/b/MyLib.cql')).to.equal('MyLib');
    });
    it('handles Windows separators at the top level', () => {
      expect(libraryNameOf('C:\\a\\b\\MyLib.cql')).to.equal('MyLib');
    });
    it('handles Windows forward-slash separators', () => {
      expect(libraryNameOf('C:/a/b/MyLib.cql')).to.equal('MyLib');
    });
    it('passes through a basename without .cql', () => {
      expect(libraryNameOf('/a/b/MyLib')).to.equal('MyLib');
    });
  });

  describe('runStoreDir', () => {
    it('places runs under <root>/.cql-debug/test-runs', () => {
      expect(runStoreDir('/work/project')).to.equal('/work/project/.cql-debug/test-runs');
    });
    it('handles a Windows backslash root', () => {
      expect(runStoreDir('C:\\work\\project')).to.equal('C:\\work\\project\\.cql-debug\\test-runs');
    });
    it('handles a Windows forward-slash root', () => {
      expect(runStoreDir('C:/work/project')).to.equal('C:\\work\\project\\.cql-debug\\test-runs');
    });
  });
});