import { expect } from 'chai';
import { diffRuns, diffRunsOrNoPrevious } from '../../../src/testPipeline/diff.js';
import type { RunRecord } from '../../../src/testPipeline/testCaseModel.js';

function mkRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    hash: 'h',
    timestamp: '20260101T000000000Z',
    suiteName: 'S',
    libraryName: 'L',
    libraryVersion: '1.0.0',
    cqlFile: '/tmp/L.cql',
    fhirVersion: 'R4',
    configPath: null,
    cases: [],
    counts: { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 },
    parametersApplied: [],
    versions: {},
    ...overrides,
  };
}

describe('testPipeline/diff', () => {
  describe('diffRuns', () => {
    it('reports empty diff for identical runs', () => {
      const run = mkRun({
        cases: [{ patientId: 'p1', status: 'passed', expressions: [{ name: 'X', value: '1' }], errors: [] }],
        counts: { total: 1, passed: 1, failed: 0, skipped: 0, errored: 0 },
      });
      const d = diffRuns(run, run);
      expect(d.added).to.have.length(0);
      expect(d.removed).to.have.length(0);
      expect(d.changed).to.have.length(0);
      expect(d.statusFlips).to.have.length(0);
      expect(d.unchangedCount).to.equal(1);
    });

    it('detects added cases (in after only)', () => {
      const before = mkRun({ cases: [] });
      const after = mkRun({
        cases: [{ patientId: 'p1', status: 'passed', expressions: [], errors: [] }],
      });
      const d = diffRuns(before, after);
      expect(d.added).to.have.length(1);
      expect(d.added[0].patientId).to.equal('p1');
      expect(d.removed).to.have.length(0);
    });

    it('detects removed cases (in before only)', () => {
      const before = mkRun({
        cases: [{ patientId: 'p1', status: 'passed', expressions: [], errors: [] }],
      });
      const after = mkRun({ cases: [] });
      const d = diffRuns(before, after);
      expect(d.removed).to.have.length(1);
      expect(d.removed[0].patientId).to.equal('p1');
      expect(d.added).to.have.length(0);
    });

    it('detects expression value changes', () => {
      const before = mkRun({
        cases: [{ patientId: 'p1', status: 'passed', expressions: [{ name: 'X', value: '1' }], errors: [] }],
      });
      const after = mkRun({
        cases: [{ patientId: 'p1', status: 'passed', expressions: [{ name: 'X', value: '2' }], errors: [] }],
      });
      const d = diffRuns(before, after);
      expect(d.changed).to.deep.equal([
        { patientId: 'p1', expressionName: 'X', before: '1', after: '2', kind: 'value-changed' },
      ]);
      expect(d.statusFlips).to.have.length(0);
      expect(d.unchangedCount).to.equal(0);
    });

    it('detects status flips (pass→fail, etc.)', () => {
      const before = mkRun({
        cases: [{ patientId: 'p1', status: 'passed', expressions: [], errors: [] }],
      });
      const after = mkRun({
        cases: [{ patientId: 'p1', status: 'failed', expressions: [], errors: [] }],
      });
      const d = diffRuns(before, after);
      expect(d.statusFlips).to.deep.equal([{ patientId: 'p1', before: 'passed', after: 'failed' }]);
    });

    it('handles a mixed scenario (add + remove + change + unchanged)', () => {
      const before = mkRun({
        cases: [
          { patientId: 'p1', status: 'passed', expressions: [{ name: 'X', value: '1' }], errors: [] },
          { patientId: 'p2', status: 'passed', expressions: [], errors: [] }, // will be removed
          { patientId: 'p3', status: 'passed', expressions: [], errors: [] }, // unchanged
        ],
      });
      const after = mkRun({
        cases: [
          { patientId: 'p1', status: 'passed', expressions: [{ name: 'X', value: '2' }], errors: [] }, // changed
          { patientId: 'p3', status: 'passed', expressions: [], errors: [] }, // unchanged
          { patientId: 'p4', status: 'passed', expressions: [], errors: [] }, // added
        ],
      });
      const d = diffRuns(before, after);
      expect(d.added.map((c) => c.patientId)).to.deep.equal(['p4']);
      expect(d.removed.map((c) => c.patientId)).to.deep.equal(['p2']);
      expect(d.changed).to.deep.equal([{ patientId: 'p1', expressionName: 'X', before: '1', after: '2', kind: 'value-changed' }]);
      expect(d.unchangedCount).to.equal(1);
    });

    it('summary string includes all counts', () => {
      const before = mkRun({
        cases: [
          { patientId: 'p1', status: 'passed', expressions: [], errors: [] },
          { patientId: 'p2', status: 'passed', expressions: [], errors: [] },
        ],
      });
      const after = mkRun({
        cases: [
          { patientId: 'p1', status: 'failed', expressions: [], errors: [] },
          { patientId: 'p3', status: 'passed', expressions: [], errors: [] },
        ],
      });
      const d = diffRuns(before, after);
      expect(d.summary).to.include('1 added');
      expect(d.summary).to.include('1 removed');
      expect(d.summary).to.include('1 status flips');
    });
  });

  describe('diffRunsOrNoPrevious', () => {
    it('returns DiffReport when both runs are provided', () => {
      const before = mkRun({ cases: [] });
      const after = mkRun({
        cases: [{ patientId: 'p1', status: 'passed', expressions: [], errors: [] }],
      });
      const d = diffRunsOrNoPrevious('S', before, after);
      expect((d as { added?: unknown[] }).added).to.have.length(1);
    });

    it('returns NoPreviousRunReport when before is null', () => {
      const after = mkRun({
        cases: [{ patientId: 'p1', status: 'passed', expressions: [], errors: [] }],
      });
      const d = diffRunsOrNoPrevious('MySuite', null, after);
      expect(d).to.have.property('status', 'no_previous_run');
      expect(d).to.have.property('suite', 'MySuite');
      expect((d as { message: string }).message).to.include('MySuite');
      expect((d as { message: string }).message).to.include('previous run');
    });
  });

  describe('expression add/remove detection', () => {
    it('detects expression-added (in after but not before)', () => {
      const before = mkRun({
        cases: [{ patientId: 'p1', status: 'passed', expressions: [], errors: [] }],
      });
      const after = mkRun({
        cases: [{ patientId: 'p1', status: 'passed', expressions: [{ name: 'NewDefine', value: '42' }], errors: [] }],
      });
      const d = diffRuns(before, after);
      expect(d.changed).to.deep.equal([
        { patientId: 'p1', expressionName: 'NewDefine', before: '', after: '42', kind: 'expression-added' },
      ]);
    });

    it('detects expression-removed (in before but not after)', () => {
      const before = mkRun({
        cases: [{ patientId: 'p1', status: 'passed', expressions: [{ name: 'OldDefine', value: '99' }], errors: [] }],
      });
      const after = mkRun({
        cases: [{ patientId: 'p1', status: 'passed', expressions: [], errors: [] }],
      });
      const d = diffRuns(before, after);
      expect(d.changed).to.deep.equal([
        { patientId: 'p1', expressionName: 'OldDefine', before: '99', after: '', kind: 'expression-removed' },
      ]);
    });

    it('revert scenario: same values → no changes, no additions', () => {
      const same = mkRun({
        cases: [{ patientId: 'p1', status: 'passed', expressions: [{ name: 'X', value: '1' }], errors: [] }],
      });
      const d = diffRuns(same, mkRun({
        cases: [{ patientId: 'p1', status: 'passed', expressions: [{ name: 'X', value: '1' }], errors: [] }],
      }));
      expect(d.changed).to.have.length(0);
      expect(d.unchangedCount).to.equal(1);
    });

    it('mixed add + remove + value-changed on the same patient', () => {
      const before = mkRun({
        cases: [{
          patientId: 'p1', status: 'passed',
          expressions: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }],
          errors: [],
        }],
      });
      const after = mkRun({
        cases: [{
          patientId: 'p1', status: 'passed',
          expressions: [{ name: 'A', value: '1' }, { name: 'C', value: '3' }], // A unchanged, B removed, C added
          errors: [],
        }],
      });
      const d = diffRuns(before, after);
      expect(d.changed).to.have.length(2);
      const removed = d.changed.find((c) => c.kind === 'expression-removed');
      const added = d.changed.find((c) => c.kind === 'expression-added');
      expect(removed).to.deep.include({ patientId: 'p1', expressionName: 'B', before: '2', after: '' });
      expect(added).to.deep.include({ patientId: 'p1', expressionName: 'C', before: '', after: '3' });
    });
  });
});
