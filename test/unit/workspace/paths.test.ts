import { expect } from 'chai';
import { libraryNameOf, pathToUri, runStoreDir, uriToPath } from '../../../src/workspace/paths.js';

describe('workspace/paths', () => {
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