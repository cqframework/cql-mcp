import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildExclusionSet,
  getMeasureReportData,
  loadSuite,
} from '../../../src/testPipeline/testCaseLoader.js';

function mkSuite(layout: Record<string, Record<string, string>>): string {
  // layout: { '<libraryName>': { '<patient-uuid-dir>': '<measureReport-content>', ... }, ... }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testCaseLoader-'));
  for (const [libName, cases] of Object.entries(layout)) {
    const libDir = path.join(root, libName);
    fs.mkdirSync(libDir, { recursive: true });
    for (const [caseDir, reportContent] of Object.entries(cases)) {
      const caseDirPath = path.join(libDir, caseDir);
      fs.mkdirSync(caseDirPath, { recursive: true });
      if (reportContent) {
        fs.writeFileSync(path.join(caseDirPath, 'MeasureReport-x.json'), reportContent);
      }
    }
  }
  return root;
}

const SAMPLE_REPORT = JSON.stringify({
  resourceType: 'MeasureReport',
  contained: [
    {
      resourceType: 'Parameters',
      parameter: [{ name: 'subject', valueString: 'patient-1' }],
    },
  ],
  extension: [
    {
      url: 'http://hl7.org/fhir/us/cqfmeasures/StructureDefinition/cqfm-testCaseDescription',
      valueMarkdown: '**Patient has X** during MP.',
    },
  ],
  group: [
    {
      id: 'Group_1',
      population: [
        {
          id: 'InitialPopulation_1',
          code: {
            coding: [
              {
                system: 'http://terminology.hl7.org/CodeSystem/measure-population',
                code: 'initial-population',
                display: 'Initial Population',
              },
            ],
          },
          count: 1,
        },
        {
          code: {
            coding: [
              { code: 'denominator', display: 'Denominator' },
            ],
          },
          count: 1,
        },
        {
          code: {
            coding: [
              { code: 'numerator', display: 'Numerator' },
            ],
          },
          count: 1,
        },
      ],
    },
  ],
});

describe('testPipeline/testCaseLoader', () => {
  describe('buildExclusionSet', () => {
    it('always includes "shared"', () => {
      const set = buildExclusionSet();
      expect(set.has('shared')).to.equal(true);
    });

    it('unions multiple sources', () => {
      const set = buildExclusionSet(['a', 'b'], ['b', 'c']);
      expect([...set].sort()).to.deep.equal(['a', 'b', 'c', 'shared']);
    });

    it('accepts an iterable (Set, Array, etc.)', () => {
      const set = buildExclusionSet(new Set(['x']));
      expect(set.has('x')).to.equal(true);
      expect(set.has('shared')).to.equal(true);
    });
  });

  describe('loadSuite (Layout A)', () => {
    it('returns empty when suiteRoot does not exist', () => {
      expect(loadSuite('/no/such/path', 'Lib', new Set())).to.deep.equal([]);
    });

    it('returns empty when library subdirectory does not exist', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'testCaseLoader-empty-'));
      try {
        expect(loadSuite(root, 'Lib', new Set())).to.deep.equal([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('enumerates patient-uuid dirs as test cases', () => {
      const root = mkSuite({
        Lib: { 'p1': SAMPLE_REPORT, 'p2': SAMPLE_REPORT },
      });
      try {
        const cases = loadSuite(root, 'Lib', new Set());
        expect(cases).to.have.length(2);
        const names = cases.map((c) => c.name).sort();
        expect(names).to.deep.equal(['p1', 'p2']);
        expect(cases[0].path).to.include(path.join('Lib', 'p1'));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('excludes shared/ sibling dir regardless of exclusion set', () => {
      const root = mkSuite({ Lib: { 'p1': SAMPLE_REPORT } });
      try {
        fs.mkdirSync(path.join(root, 'Lib', 'shared'));
        const cases = loadSuite(root, 'Lib', new Set());
        expect(cases.map((c) => c.name)).to.deep.equal(['p1']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('excludes caller-supplied dirs (union with shared)', () => {
      const root = mkSuite({
        Lib: { 'p1': SAMPLE_REPORT, 'p2': SAMPLE_REPORT, 'p3': SAMPLE_REPORT },
      });
      try {
        const excluded = buildExclusionSet(['p2']);
        const cases = loadSuite(root, 'Lib', excluded);
        expect(cases.map((c) => c.name).sort()).to.deep.equal(['p1', 'p3']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('skips non-directory entries (e.g. loose .cql files)', () => {
      const root = mkSuite({ Lib: { 'p1': SAMPLE_REPORT } });
      try {
        fs.writeFileSync(path.join(root, 'Lib', 'Lib.cql'), 'library Lib version \'1.0.0\'');
        const cases = loadSuite(root, 'Lib', new Set());
        expect(cases.map((c) => c.name)).to.deep.equal(['p1']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('getMeasureReportData', () => {
    it('returns undefined when dir does not exist', () => {
      expect(getMeasureReportData('/no/such/dir')).to.equal(undefined);
    });

    it('returns undefined when no MeasureReport file exists', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-report-'));
      try {
        expect(getMeasureReportData(root)).to.equal(undefined);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('extracts patientId, populations, and description from a valid report', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-'));
      try {
        fs.writeFileSync(path.join(root, 'MeasureReport-x.json'), SAMPLE_REPORT);
        const data = getMeasureReportData(root);
        expect(data?.patientId).to.equal('patient-1');
        expect(data?.populations).to.have.length(3);
        const codes = data?.populations?.map((p) => p.code).sort();
        expect(codes).to.deep.equal(['denominator', 'initial-population', 'numerator']);
        // markdown stripped
        expect(data?.description).to.equal('Patient has X during MP.');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('returns undefined when the MeasureReport is malformed', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-bad-'));
      try {
        fs.writeFileSync(path.join(root, 'MeasureReport-x.json'), '{ not json');
        expect(getMeasureReportData(root)).to.equal(undefined);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});
