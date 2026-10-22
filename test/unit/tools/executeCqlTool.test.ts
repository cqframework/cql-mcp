import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildExecuteCqlRequest } from '../../../src/tools/executeCqlTool.js';
import { pathToUri } from '../../../src/workspace/paths.js';

describe('executeCqlTool.buildExecuteCqlRequest', () => {
  it('passes through the caller-supplied libraryVersion', () => {
    const req = buildExecuteCqlRequest({
      cqlFile: '/x/lib.cql',
      libraryVersion: '1.2.3',
    });
    expect(req.libraries[0]?.libraryVersion).to.equal('1.2.3');
  });

  it('defaults libraryVersion to null when omitted', () => {
    const req = buildExecuteCqlRequest({ cqlFile: '/x/lib.cql' });
    expect(req.libraries[0]?.libraryVersion).to.equal(null);
  });

  it('uses pathToUri (not URI.file) so Windows-style paths work on POSIX hosts', () => {
    const req = buildExecuteCqlRequest({ cqlFile: '/x/lib.cql' });
    expect(req.libraries[0]?.libraryUri).to.equal('file:///x');
  });

  describe('modelUri', () => {
    let tmpDir: string;

    before(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cql-exec-model-'));
    });

    after(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('defaults model to null when modelUri is omitted', () => {
      const req = buildExecuteCqlRequest({ cqlFile: '/x/lib.cql' });
      expect(req.libraries[0]?.model).to.equal(null);
    });

    it('defaults model to null when modelUri points to a non-existent path', () => {
      const req = buildExecuteCqlRequest({
        cqlFile: '/x/lib.cql',
        modelUri: path.join(tmpDir, 'does-not-exist'),
      });
      expect(req.libraries[0]?.model).to.equal(null);
    });

    it('builds model with default modelName "FHIR" when modelUri is provided', () => {
      const req = buildExecuteCqlRequest({
        cqlFile: '/x/lib.cql',
        modelUri: tmpDir,
      });
      expect(req.libraries[0]?.model?.modelName).to.equal('FHIR');
    });

    it('honors a caller-supplied modelName', () => {
      const req = buildExecuteCqlRequest({
        cqlFile: '/x/lib.cql',
        modelUri: tmpDir,
        modelName: 'US-Core',
      });
      expect(req.libraries[0]?.model?.modelName).to.equal('US-Core');
    });

    it('emits modelUri as a file:// URI for a POSIX modelUri', () => {
      const req = buildExecuteCqlRequest({
        cqlFile: '/x/lib.cql',
        modelUri: tmpDir,
      });
      expect(req.libraries[0]?.model?.modelUri).to.equal(pathToUri(fs.realpathSync(tmpDir)));
    });

    it('resolves symlinks so Java Files.walk can traverse the directory (LS IgStandardRepository does not follow symlinks by default)', () => {
      const target = path.join(tmpDir, 'real');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'Patient-real.json'), '{}');
      const link = path.join(tmpDir, 'link');
      fs.symlinkSync(target, link);
      const req = buildExecuteCqlRequest({
        cqlFile: '/x/lib.cql',
        modelUri: link,
      });
      expect(req.libraries[0]?.model?.modelUri).to.equal(pathToUri(fs.realpathSync(target)));
    });

    it('cross-platform: pathToUri converts a Windows backslash path to file:///C:/... on a POSIX host', () => {
      if (process.platform === 'win32') return;
      expect(pathToUri('C:\\path\\to\\data')).to.equal('file:///C:/path/to/data');
    });

    it('cross-platform: pathToUri converts a Windows forward-slash path to file:///C:/... on a POSIX host', () => {
      if (process.platform === 'win32') return;
      expect(pathToUri('C:/path/to/data')).to.equal('file:///C:/path/to/data');
    });
  });
});
