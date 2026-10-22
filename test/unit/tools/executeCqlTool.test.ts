import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildExecuteCqlRequest, modelFor } from '../../../src/tools/executeCqlTool.js';
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

  describe('modelFor', () => {
    // A test-case folder becomes the model the LS reads patient data from. The fs is injected so
    // each path form runs on any host.
    //
    // | Form                  | Test-case folder           | modelUri                   |
    // | --------------------- | -------------------------- | -------------------------- |
    // | macOS / Linux         | /ig/input/tests/L/p1       | file:///ig/input/tests/L/p1 |
    // | Windows backslash     | C:\ig\input\tests\L\p1     | file:///C:/ig/input/tests/L/p1 |
    // | Windows forward slash | C:/ig/input/tests/L/p1     | file:///C:/ig/input/tests/L/p1 |
    const fakeFs = { existsSync: () => true, realpathSync: (p: string) => p };

    it('builds a FHIR model for a POSIX folder', () => {
      expect(modelFor('/ig/input/tests/L/p1', undefined, fakeFs)).to.deep.equal({
        modelName: 'FHIR',
        modelUri: 'file:///ig/input/tests/L/p1',
      });
    });
    it('builds a FHIR model for a Windows backslash folder', () => {
      if (process.platform === 'win32') return;
      expect(modelFor('C:\\ig\\input\\tests\\L\\p1', undefined, fakeFs)?.modelUri).to.equal(
        'file:///C:/ig/input/tests/L/p1',
      );
    });
    it('builds a FHIR model for a Windows forward-slash folder', () => {
      if (process.platform === 'win32') return;
      expect(modelFor('C:/ig/input/tests/L/p1', undefined, fakeFs)?.modelUri).to.equal(
        'file:///C:/ig/input/tests/L/p1',
      );
    });
    it('returns null for a missing folder or no folder', () => {
      expect(modelFor('/nope', undefined, { ...fakeFs, existsSync: () => false })).to.equal(null);
      expect(modelFor(undefined)).to.equal(null);
    });
  });

  describe('IG defaults', () => {
    // A file in the IG Publisher default layout (…/input/cql/X.cql with an ig.ini at or above the
    // project root) gets rootDir plus the default-layout terminologyUri and optionsPath. Without
    // rootDir the LS loads no IG packages, so USQualityCore/USCore modelinfo and IG namespaces fail.
    let ig: string;
    let cqlFile: string;

    beforeEach(() => {
      ig = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cql-exec-ig-')));
      fs.mkdirSync(path.join(ig, 'input', 'cql'), { recursive: true });
      fs.mkdirSync(path.join(ig, 'input', 'vocabulary', 'valueset'), { recursive: true });
      fs.writeFileSync(path.join(ig, 'ig.ini'), '[IG]\n');
      fs.writeFileSync(path.join(ig, 'input', 'cql', 'cql-options.json'), '{}');
      cqlFile = path.join(ig, 'input', 'cql', 'L.cql');
      fs.writeFileSync(cqlFile, "library L version '1.0.0'\n");
    });
    afterEach(() => fs.rmSync(ig, { recursive: true, force: true }));

    it('derives rootDir, terminologyUri and optionsPath for an IG-layout file', () => {
      const req = buildExecuteCqlRequest({ cqlFile });
      expect(req.rootDir).to.equal(pathToUri(ig));
      expect(req.optionsPath).to.equal(pathToUri(path.join(ig, 'input', 'cql', 'cql-options.json')));
      expect(req.libraries[0]?.terminologyUri).to.equal(
        pathToUri(path.join(ig, 'input', 'vocabulary', 'valueset')),
      );
    });

    it('leaves terminologyUri and optionsPath null when those paths do not exist', () => {
      fs.rmSync(path.join(ig, 'input', 'vocabulary'), { recursive: true });
      fs.rmSync(path.join(ig, 'input', 'cql', 'cql-options.json'));
      const req = buildExecuteCqlRequest({ cqlFile });
      expect(req.rootDir).to.equal(pathToUri(ig));
      expect(req.optionsPath).to.equal(null);
      expect(req.libraries[0]?.terminologyUri).to.equal(null);
    });

    it('lets explicit arguments override the derived values', () => {
      const other = path.join(ig, 'other');
      fs.mkdirSync(other);
      const options = path.join(other, 'opts.json');
      fs.writeFileSync(options, '{}');
      const req = buildExecuteCqlRequest({ cqlFile, rootDir: other, terminologyUri: other, optionsPath: options });
      expect(req.rootDir).to.equal(pathToUri(other));
      expect(req.optionsPath).to.equal(pathToUri(options));
      expect(req.libraries[0]?.terminologyUri).to.equal(pathToUri(other));
    });

    it('sends no rootDir when there is no ig.ini', () => {
      fs.rmSync(path.join(ig, 'ig.ini'));
      const req = buildExecuteCqlRequest({ cqlFile });
      expect(req.rootDir).to.equal(null);
      expect(req.optionsPath).to.equal(null);
      expect(req.libraries[0]?.terminologyUri).to.equal(null);
    });

    it('sends no rootDir for a scratch file outside input/cql, even inside an IG', () => {
      const probe = path.join(ig, 'temp', 'probe');
      fs.mkdirSync(probe, { recursive: true });
      const scratch = path.join(probe, 'Probe.cql');
      fs.writeFileSync(scratch, 'library Probe\n');
      expect(buildExecuteCqlRequest({ cqlFile: scratch }).rootDir).to.equal(null);
    });
  });
});
