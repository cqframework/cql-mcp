import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadTestConfig,
  resolveTestConfigPath,
} from '../../../src/testPipeline/configLoader.js';

describe('testPipeline/configLoader', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'configLoader-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('resolveTestConfigPath', () => {
    it('returns null when neither config.jsonc nor config.json exists', () => {
      expect(resolveTestConfigPath(tmp)).to.equal(null);
    });

    it('returns config.jsonc path when it exists', () => {
      fs.writeFileSync(path.join(tmp, 'config.jsonc'), '{}');
      expect(resolveTestConfigPath(tmp)).to.equal(path.join(tmp, 'config.jsonc'));
    });

    it('returns config.json path when only it exists', () => {
      fs.writeFileSync(path.join(tmp, 'config.json'), '{}');
      expect(resolveTestConfigPath(tmp)).to.equal(path.join(tmp, 'config.json'));
    });

    it('prefers config.jsonc over config.json when both exist', () => {
      fs.writeFileSync(path.join(tmp, 'config.jsonc'), '{}');
      fs.writeFileSync(path.join(tmp, 'config.json'), '{}');
      expect(resolveTestConfigPath(tmp)).to.equal(path.join(tmp, 'config.jsonc'));
    });
  });

  describe('loadTestConfig', () => {
    it('returns DEFAULT_TEST_CONFIG when path is null', () => {
      const config = loadTestConfig(null);
      expect(config.testCasesToExclude).to.deep.equal([]);
      expect(config.resultFormat).to.equal('flat');
      expect(config.flatResultsInSubfolder).to.equal(false);
    });

    it('returns DEFAULT_TEST_CONFIG when file does not exist', () => {
      const config = loadTestConfig(path.join(tmp, 'missing.json'));
      expect(config.testCasesToExclude).to.deep.equal([]);
    });

    it('parses a valid JSON config', () => {
      const file = path.join(tmp, 'config.jsonc');
      fs.writeFileSync(
        file,
        JSON.stringify({
          testCasesToExclude: [{ library: 'L', testCase: 't1', reason: 'r' }],
          resultFormat: 'individual',
          parameters: [{ name: 'P', type: 'String', value: 'v' }],
        }),
      );
      const config = loadTestConfig(file);
      expect(config.testCasesToExclude).to.have.length(1);
      expect(config.resultFormat).to.equal('individual');
      expect(config.parameters).to.have.length(1);
    });

    it('tolerates // line comments (jsonc)', () => {
      const file = path.join(tmp, 'config.jsonc');
      fs.writeFileSync(
        file,
        `{
          // a comment
          "resultFormat": "individual",
          "parameters": [{ "name": "P", "type": "String", "value": "v" }]
        }`,
      );
      const config = loadTestConfig(file);
      expect(config.resultFormat).to.equal('individual');
      expect(config.parameters).to.have.length(1);
    });

    it('tolerates /* */ block comments (jsonc)', () => {
      const file = path.join(tmp, 'config.jsonc');
      fs.writeFileSync(
        file,
        `{
          /* a block comment */
          "resultFormat": "individual"
        }`,
      );
      const config = loadTestConfig(file);
      expect(config.resultFormat).to.equal('individual');
    });

    it('tolerates trailing commas', () => {
      const file = path.join(tmp, 'config.jsonc');
      fs.writeFileSync(file, `{
        "testCasesToExclude": [],
        "resultFormat": "individual",
        "parameters": [],
      }`);
      const config = loadTestConfig(file);
      expect(config.resultFormat).to.equal('individual');
    });

    it('falls back to DEFAULT_TEST_CONFIG on malformed JSON', () => {
      const file = path.join(tmp, 'config.jsonc');
      fs.writeFileSync(file, '{ not valid json }');
      const config = loadTestConfig(file);
      expect(config).to.deep.equal({
        testCasesToExclude: [],
        resultFormat: 'flat',
        flatResultsInSubfolder: false,
      });
    });

    it('falls back to DEFAULT_TEST_CONFIG when parsed value is not an object', () => {
      const file = path.join(tmp, 'config.jsonc');
      fs.writeFileSync(file, '"just a string"');
      const config = loadTestConfig(file);
      expect(config.testCasesToExclude).to.deep.equal([]);
    });

    it('fills missing fields with defaults', () => {
      const file = path.join(tmp, 'config.jsonc');
      fs.writeFileSync(file, '{"parameters": []}');
      const config = loadTestConfig(file);
      expect(config.testCasesToExclude).to.deep.equal([]);
      expect(config.resultFormat).to.equal('flat');
      expect(config.flatResultsInSubfolder).to.equal(false);
    });
  });
});
