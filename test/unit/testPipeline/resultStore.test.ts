import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AmbiguousRunRefError,
  contentHash,
  listRuns,
  loadRun,
  pruneOldRuns,
  readLatestPointer,
  readPreviousPointer,
  saveRun,
  updatePointers,
} from '../../../src/testPipeline/resultStore.js';
import { sanitizeSuiteNameForFs, latestPointerPath, fsSafeTimestamp, runRecordPath } from '../../../src/workspace/paths.js';
import type { RunRecord } from '../../../src/testPipeline/testCaseModel.js';

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'resultStore-'));
}

function mkRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    hash: '0'.repeat(64),
    timestamp: '20260101T000000000Z',
    suiteName: 'CMSDemo',
    libraryName: 'CMSDemo',
    libraryVersion: '1.0.0',
    cqlFile: '/tmp/CMSDemo.cql',
    fhirVersion: 'R4',
    configPath: null,
    cases: [
      { patientId: 'p1', status: 'passed', expressions: [{ name: 'X', value: '1' }], errors: [] },
    ],
    counts: { total: 1, passed: 1, failed: 0, skipped: 0, errored: 0 },
    parametersApplied: [],
    versions: { languageServer: '4.10.0' },
    ...overrides,
  };
}

describe('testPipeline/resultStore', () => {
  describe('contentHash', () => {
    it('produces identical hashes for identical inputs regardless of key order', () => {
      const a = contentHash({ b: 1, a: 2 });
      const b = contentHash({ a: 2, b: 1 });
      expect(a).to.equal(b);
    });

    it('produces different hashes when any value differs', () => {
      const a = contentHash({ x: '1' });
      const b = contentHash({ x: '2' });
      expect(a).to.not.equal(b);
    });

    it('handles nested objects and arrays deterministically', () => {
      const a = contentHash({ list: [1, 2, 3], nested: { y: 'a', x: 'b' } });
      const b = contentHash({ nested: { x: 'b', y: 'a' }, list: [1, 2, 3] });
      expect(a).to.equal(b);
    });

    it('returns 64-char hex string', () => {
      expect(contentHash({})).to.match(/^[0-9a-f]{64}$/);
    });
  });

  describe('sanitizeSuiteNameForFs', () => {
    it('replaces unsafe characters with underscore', () => {
      expect(sanitizeSuiteNameForFs('CMS Demo/Foo')).to.equal('CMS_Demo_Foo');
    });

    it('preserves dots, dashes, and underscores', () => {
      expect(sanitizeSuiteNameForFs('CMS-153.v1')).to.equal('CMS-153.v1');
    });

    it('caps length at 64 chars', () => {
      const long = 'a'.repeat(100);
      expect(sanitizeSuiteNameForFs(long)).to.have.length(64);
    });

    it('returns "default" for empty/whitespace input', () => {
      expect(sanitizeSuiteNameForFs('')).to.equal('default');
      expect(sanitizeSuiteNameForFs('   ')).to.equal('default');
    });
  });

  describe('saveRun / loadRun', () => {
    it('writes and reads back a round-trip record', () => {
      const root = mkRoot();
      try {
        const run = mkRun();
        const file = saveRun(root, run);
        expect(fs.existsSync(file)).to.equal(true);
        const loaded = loadRun(root, run.timestamp);
        expect(loaded).to.deep.equal(run);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('looks up by hash prefix', () => {
      const root = mkRoot();
      try {
        const run = mkRun({ hash: 'abcd1234'.repeat(8) });
        saveRun(root, run);
        const loaded = loadRun(root, 'abcd1234');
        expect(loaded?.hash).to.equal('abcd1234'.repeat(8));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('returns null when no match exists', () => {
      const root = mkRoot();
      try {
        expect(loadRun(root, 'nothing')).to.equal(null);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('plain accumulation: same hash + different timestamps → two files', () => {
      const root = mkRoot();
      try {
        const sameHash = 'a'.repeat(64);
        const run1 = mkRun({ timestamp: '20260101T000000000Z', hash: sameHash });
        const run2 = mkRun({ timestamp: '20260102T000000000Z', hash: sameHash });
        saveRun(root, run1);
        saveRun(root, run2);
        const all = listRuns(root);
        expect(all).to.have.length(2);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('updatePointers / readLatestPointer / readPreviousPointer', () => {
    it('writes latest-<suite>.json pointing at the run hash', () => {
      const root = mkRoot();
      try {
        updatePointers(root, 'CMSDemo', 'h1');
        const ptr = readLatestPointer(root, 'CMSDemo');
        expect(ptr?.hash).to.equal('h1');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('rotates previous pointer on subsequent updates', () => {
      const root = mkRoot();
      try {
        updatePointers(root, 'CMSDemo', 'h1');
        updatePointers(root, 'CMSDemo', 'h2');
        expect(readLatestPointer(root, 'CMSDemo')?.hash).to.equal('h2');
        expect(readPreviousPointer(root, 'CMSDemo')?.hash).to.equal('h1');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('returns null when no previous run has been recorded', () => {
      const root = mkRoot();
      try {
        updatePointers(root, 'CMSDemo', 'h1');
        expect(readPreviousPointer(root, 'CMSDemo')).to.equal(null);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('readLatestPointer returns null on malformed JSON without throwing', () => {
      const root = mkRoot();
      try {
        updatePointers(root, 'CMSDemo', 'h1'); // ensures dir exists
        const p = latestPointerPath(root, 'CMSDemo');
        fs.writeFileSync(p, '{not valid json', 'utf-8');
        expect(readLatestPointer(root, 'CMSDemo')).to.equal(null);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('readLatestPointer propagates non-ENOENT fs errors (does not silently null out)', () => {
      // Skip on Windows: chmod semantics differ; skip if running as root since
      // chmod 0o000 doesn't deny access for root on POSIX.
      if (process.platform === 'win32') return;
      if (typeof process.getuid === 'function' && process.getuid() === 0) return;

      const root = mkRoot();
      try {
        updatePointers(root, 'CMSDemo', 'h1');
        const p = latestPointerPath(root, 'CMSDemo');
        fs.chmodSync(p, 0o000);
        let threw = false;
        try {
          readLatestPointer(root, 'CMSDemo');
        } catch {
          threw = true;
        } finally {
          fs.chmodSync(p, 0o600);
        }
        expect(threw).to.equal(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('per-suite pointers do not collide across suites', () => {
      const root = mkRoot();
      try {
        updatePointers(root, 'A', 'hashA');
        updatePointers(root, 'B', 'hashB');
        expect(readLatestPointer(root, 'A')?.hash).to.equal('hashA');
        expect(readLatestPointer(root, 'B')?.hash).to.equal('hashB');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('sanitizes suite names in pointer file paths', () => {
      const root = mkRoot();
      try {
        updatePointers(root, 'Suite With Spaces', 'h1');
        const dir = path.join(root, '.cql-debug', 'test-runs');
        const files = fs.readdirSync(dir);
        expect(files.some((f) => f.startsWith('latest-Suite_With_Spaces'))).to.equal(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('listRuns', () => {
    it('returns runs newest-first', () => {
      const root = mkRoot();
      try {
        saveRun(root, mkRun({ timestamp: '20260101T000000000Z', hash: 'a'.repeat(64) }));
        saveRun(root, mkRun({ timestamp: '20260103T000000000Z', hash: 'c'.repeat(64) }));
        saveRun(root, mkRun({ timestamp: '20260102T000000000Z', hash: 'b'.repeat(64) }));
        const all = listRuns(root);
        expect(all.map((r) => r.hash)).to.deep.equal(['c'.repeat(64), 'b'.repeat(64), 'a'.repeat(64)]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('excludes pointer files from listings', () => {
      const root = mkRoot();
      try {
        const realHash = 'f'.repeat(64);
        saveRun(root, mkRun({ hash: realHash }));
        updatePointers(root, 'CMSDemo', realHash);
        const all = listRuns(root);
        expect(all).to.have.length(1);
        expect(all[0].hash).to.equal(realHash);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('filters by suite name', () => {
      const root = mkRoot();
      try {
        const ha = 'a'.repeat(64);
        const hb = 'b'.repeat(64);
        saveRun(root, mkRun({ suiteName: 'A', hash: ha }));
        saveRun(root, mkRun({ suiteName: 'B', hash: hb }));
        expect(listRuns(root, { suiteName: 'A' }).map((r) => r.hash)).to.deep.equal([ha]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('applies limit', () => {
      const root = mkRoot();
      try {
        for (let i = 0; i < 5; i++) {
          saveRun(
            root,
            mkRun({
              timestamp: `2026010${i + 1}T000000000Z`,
              hash: i.toString(16).padStart(8, '0').repeat(8), // 64-char hex hash varying per i
            }),
          );
        }
        expect(listRuns(root, { limit: 2 })).to.have.length(2);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('computes passRate correctly', () => {
      const root = mkRoot();
      try {
        saveRun(
          root,
          mkRun({
            hash: 'e'.repeat(64),
            cases: [
              { patientId: 'p1', status: 'passed', expressions: [], errors: [] },
              { patientId: 'p2', status: 'failed', expressions: [], errors: [] },
            ],
            counts: { total: 2, passed: 1, failed: 1, skipped: 0, errored: 0 },
          }),
        );
        const [summary] = listRuns(root);
        expect(summary.passRate).to.equal(0.5);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('pruneOldRuns', () => {
    it('keeps the most recent N runs and deletes older ones', () => {
      const root = mkRoot();
      try {
        for (let i = 0; i < 5; i++) {
          saveRun(
            root,
            mkRun({
              timestamp: `2026010${i + 1}T000000000Z`,
              hash: i.toString(16).padStart(8, '0').repeat(8),
            }),
          );
        }
        const deleted = pruneOldRuns(root, 2);
        expect(deleted).to.equal(3);
        expect(listRuns(root)).to.have.length(2);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('does nothing when count <= keepLast', () => {
      const root = mkRoot();
      try {
        saveRun(root, mkRun({ hash: 'a'.repeat(64) }));
        expect(pruneOldRuns(root, 5)).to.equal(0);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('throws on negative keepLast', () => {
      const root = mkRoot();
      try {
        expect(() => pruneOldRuns(root, -1)).to.throw('keepLast must be >= 0');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('loadRun — collision-safe matching', () => {
    it('disambiguates two runs sharing the same 8-char prefix by full hash', () => {
      const root = mkRoot();
      try {
        // Both files share prefix "abcd1234" in their filename, but have
        // distinct full SHA-256 hashes.
        const hashA = 'abcd1234' + 'a'.repeat(56);
        const hashB = 'abcd1234' + 'b'.repeat(56);
        saveRun(root, mkRun({ timestamp: '20260201T000000000Z', hash: hashA }));
        saveRun(root, mkRun({ timestamp: '20260202T000000000Z', hash: hashB }));
        expect(loadRun(root, hashA)?.hash).to.equal(hashA);
        expect(loadRun(root, hashB)?.hash).to.equal(hashB);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('throws AmbiguousRunRefError when a short prefix matches two runs', () => {
      const root = mkRoot();
      try {
        const hashA = 'abcd1234' + 'a'.repeat(56);
        const hashB = 'abcd1234' + 'b'.repeat(56);
        saveRun(root, mkRun({ timestamp: '20260201T000000000Z', hash: hashA }));
        saveRun(root, mkRun({ timestamp: '20260202T000000000Z', hash: hashB }));
        expect(() => loadRun(root, 'abcd1234')).to.throw(AmbiguousRunRefError, /matches 2 runs/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('does not match an ISO timestamp whose digit substring is also a valid hex prefix', () => {
      const root = mkRoot();
      try {
        // Timestamp contains "deadbeef" — a valid 8-char hex prefix. A naive
        // substring matcher could falsely link these. Strict regex must not.
        const hash = '12345678abcdef00'.repeat(4);
        saveRun(root, mkRun({ timestamp: '2026-deadbeef-f00baa00', hash }));
        expect(loadRun(root, '2026-deadbeef-f00baa00')?.hash).to.equal(hash);
        // loadRun on a hash that happens to be a substring of the timestamp
        // must NOT match (the timestamp group is checked separately).
        expect(loadRun(root, 'deadbeef')).to.equal(null);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('loadRun — timestamp refs', () => {
    // Run files are named <fsSafeTimestamp>-<hash8>.json (no ':' or '.'); runs saved before that
    // change kept the ISO form. A ref may be given in either form, in any case, or as a prefix.
    //
    // | Stored timestamp            | Ref                          | Match |
    // | --------------------------- | ---------------------------- | ----- |
    // | 2026-09-10T095126906Z       | 2026-09-10T095126906Z        | yes   |
    // | 2026-09-10T095126906Z       | 2026-09-10T09:51:26.906Z     | yes   |
    // | 2026-09-10T095126906Z       | 2026-09-10t095126906z        | yes   |
    // | 2026-09-10T095126906Z       | 2026-09-10T09:51             | yes   |
    // | 2026-09-10T04:56:52.642Z    | 2026-09-10T04:56:52.642Z     | yes   |
    // | 2026-09-10T04:56:52.642Z    | 2026-09-10T045652642Z        | yes   |
    const NEW = fsSafeTimestamp('2026-09-10T09:51:26.906Z');

    it('finds a run by its fs-safe timestamp, by the ISO form, in any case, and by prefix', () => {
      const root = mkRoot();
      try {
        const hash = 'a1b2c3d4'.repeat(8);
        saveRun(root, mkRun({ timestamp: NEW, hash }));
        for (const ref of [NEW, '2026-09-10T09:51:26.906Z', NEW.toLowerCase(), '2026-09-10T09:51']) {
          expect(loadRun(root, ref)?.hash, ref).to.equal(hash);
        }
        expect(loadRun(root, '2026-09-10T09:52')).to.equal(null);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('finds a run saved under the old ISO filename by either timestamp form', function () {
      // ':' is not allowed in Windows filenames, so the old-format file cannot exist there.
      if (process.platform === 'win32') this.skip();
      const root = mkRoot();
      try {
        const hash = 'e5f6a7b8'.repeat(8);
        const iso = '2026-09-10T04:56:52.642Z';
        const dir = path.dirname(runRecordPath(root, iso, hash));
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${iso}-${hash.slice(0, 8)}.json`), JSON.stringify(mkRun({ timestamp: iso, hash })));
        expect(loadRun(root, iso)?.hash).to.equal(hash);
        expect(loadRun(root, '2026-09-10T045652642Z')?.hash).to.equal(hash);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('pruneOldRuns — per-suite scope and pointer protection', () => {
    it('prunes each suite independently when no suiteName is given', () => {
      const root = mkRoot();
      try {
        for (let i = 0; i < 5; i++) {
          saveRun(
            root,
            mkRun({
              timestamp: `2026010${i + 1}T000000000Z`,
              suiteName: 'A',
              hash: ('a' + i.toString(16)).padStart(8, '0').repeat(8),
            }),
          );
        }
        for (let i = 0; i < 5; i++) {
          saveRun(
            root,
            mkRun({
              timestamp: `2026020${i + 1}T000000000Z`,
              suiteName: 'B',
              hash: ('b' + i.toString(16)).padStart(8, '0').repeat(8),
            }),
          );
        }
        const deleted = pruneOldRuns(root, 2);
        expect(deleted).to.equal(6); // 3 from each suite, not 8 combined
        expect(listRuns(root, { suiteName: 'A' })).to.have.length(2);
        expect(listRuns(root, { suiteName: 'B' })).to.have.length(2);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('pruneOldRuns(root, N, suiteName) prunes ONLY the named suite', () => {
      const root = mkRoot();
      try {
        for (let i = 0; i < 5; i++) {
          saveRun(
            root,
            mkRun({
              timestamp: `2026010${i + 1}T000000000Z`,
              suiteName: 'A',
              hash: ('a' + i.toString(16)).padStart(8, '0').repeat(8),
            }),
          );
        }
        for (let i = 0; i < 5; i++) {
          saveRun(
            root,
            mkRun({
              timestamp: `2026020${i + 1}T000000000Z`,
              suiteName: 'B',
              hash: ('b' + i.toString(16)).padStart(8, '0').repeat(8),
            }),
          );
        }
        const deleted = pruneOldRuns(root, 2, 'A');
        expect(deleted).to.equal(3); // only 3 from A
        expect(listRuns(root, { suiteName: 'A' })).to.have.length(2);
        expect(listRuns(root, { suiteName: 'B' })).to.have.length(5); // untouched
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('protects runs referenced by latest and previous pointers', () => {
      const root = mkRoot();
      try {
        const oldHash = 'a'.repeat(64);
        const newHash = 'b'.repeat(64);
        saveRun(
          root,
          mkRun({ timestamp: '20260101T000000000Z', hash: oldHash }),
        );
        // Two pointers — latest=newHash, previous=oldHash — but only ONE run
        // file on disk (oldHash) because the newer run was hypothetically
        // deleted out-of-band. With keepLast=0 the file MUST survive.
        fs.writeFileSync(path.join(root, '.cql-debug', 'test-runs', 'latest-CMSDemo.json'),
          JSON.stringify({ hash: newHash }), 'utf-8');
        fs.writeFileSync(path.join(root, '.cql-debug', 'test-runs', 'previous-CMSDemo.json'),
          JSON.stringify({ hash: oldHash }), 'utf-8');
        expect(pruneOldRuns(root, 0, 'CMSDemo')).to.equal(0);
        expect(listRuns(root)).to.have.length(1);
        // Safety-net sweep removes the dangling latest-* pointer (newHash not
        // loadable) but preserves previous-* (oldHash still present).
        expect(fs.existsSync(path.join(root, '.cql-debug', 'test-runs', 'latest-CMSDemo.json'))).to.equal(false);
        expect(fs.existsSync(path.join(root, '.cql-debug', 'test-runs', 'previous-CMSDemo.json'))).to.equal(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('removes malformed pointer files in the safety-net sweep', () => {
      const root = mkRoot();
      try {
        fs.mkdirSync(path.join(root, '.cql-debug', 'test-runs'), { recursive: true });
        const p = path.join(root, '.cql-debug', 'test-runs', 'latest-CMSDemo.json');
        fs.writeFileSync(p, '{not valid json', 'utf-8');
        pruneOldRuns(root, 0, 'CMSDemo');
        expect(fs.existsSync(p)).to.equal(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('does NOT delete a pointer whose target is ambiguous', () => {
      // A pointer that resolves to two distinct runs sharing the same 8-char
      // prefix is still a valid pointer — the safety-net sweep must not
      // delete it just because loadRun can't pick one.
      const root = mkRoot();
      try {
        const hashA = 'abcd1234' + 'a'.repeat(56);
        const hashB = 'abcd1234' + 'b'.repeat(56);
        saveRun(root, mkRun({ timestamp: '20260301T000000000Z', hash: hashA, suiteName: 'CMSDemo' }));
        saveRun(root, mkRun({ timestamp: '20260302T000000000Z', hash: hashB, suiteName: 'CMSDemo' }));
        // Manually write a pointer at the ambiguous short prefix (loadRun would
        // throw AmbiguousRunRefError on lookup).
        const ptrPath = latestPointerPath(root, 'CMSDemo');
        fs.writeFileSync(ptrPath, JSON.stringify({ hash: 'abcd1234' }), 'utf-8');
        expect(() => pruneOldRuns(root, 100)).to.not.throw();
        expect(fs.existsSync(ptrPath)).to.equal(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('prune + diff chain: protected run stays loadable after prune', () => {
      const root = mkRoot();
      try {
        const oldHash = 'a'.repeat(64);
        saveRun(
          root,
          mkRun({ timestamp: '20260101T000000000Z', hash: oldHash }),
        );
        updatePointers(root, 'CMSDemo', oldHash);
        // Many unrelated runs to overflow keepLast.
        for (let i = 0; i < 10; i++) {
          saveRun(
            root,
            mkRun({
              timestamp: `202602${String(i + 1).padStart(2, '0')}T000000000Z`,
              suiteName: 'OtherSuite',
              hash: ('d' + i.toString(16)).padStart(8, '0').repeat(8),
            }),
          );
        }
        pruneOldRuns(root, 5);
        // Protected run still loadable by its full hash.
        expect(loadRun(root, oldHash)?.hash).to.equal(oldHash);
        // Pointer file still readable.
        expect(readLatestPointer(root, 'CMSDemo')?.hash).to.equal(oldHash);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('contentHash — array order', () => {
    it('produces identical hashes for arrays with the same elements in different order', () => {
      const a = contentHash({ parameters: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }] });
      const b = contentHash({ parameters: [{ name: 'B', value: '2' }, { name: 'A', value: '1' }] });
      expect(a).to.equal(b);
    });

    it('produces identical hashes when primitive arrays differ only in order', () => {
      const a = contentHash({ contextValues: ['p1', 'p2', 'p3'] });
      const b = contentHash({ contextValues: ['p3', 'p1', 'p2'] });
      expect(a).to.equal(b);
    });
  });

  describe('Windows-safe filenames (CLAUDE.md cross-platform policy)', () => {
    it('runRecordPath strips colons and dots from the timestamp', () => {
      const file = runRecordPath('/root', '2026-09-10T09:51:26.906Z', 'abcdef12');
      const basename = path.basename(file);
      // No `:` or `.` anywhere in the basename (the timestamp portion must
      // be Windows-safe). Dashes are legal on NTFS so the date `2026-09-10`
      // stays intact.
      expect(basename).to.not.match(/[:]/);
      // Only one `.`, the `.json` extension.
      expect(basename.split('.').length).to.equal(2);
      expect(basename).to.match(/^2026-09-10T095126906Z-abcdef12\.json$/);
    });

    it('round-trips: saveRun then loadRun by sanitized timestamp', () => {
      const root = mkRoot();
      try {
        const run = mkRun({ timestamp: '20260910T095126906Z', hash: 'a'.repeat(64) });
        saveRun(root, run);
        const loaded = loadRun(root, '20260910T095126906Z');
        expect(loaded?.hash).to.equal('a'.repeat(64));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('fsSafeTimestamp is a no-op on already-safe input', () => {
      expect(fsSafeTimestamp('20260910T095126906Z')).to.equal('20260910T095126906Z');
    });
  });
});
