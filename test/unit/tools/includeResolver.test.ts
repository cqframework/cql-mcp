import { expect } from 'chai';
import * as path from 'node:path';
import { resolveIncludePath } from '../../../src/tools/includeResolver.js';
import { onPosix, onWindows } from '../../helpers/platform.js';

describe('tools/includeResolver', () => {
  // The fake file system's keys and the expected values are built with the host's path.join, so
  // these tests check the resolution logic rather than separator spelling (on a Windows host
  // path.join turns '/' into '\\').
  const j = (...segments: string[]) => path.join(...segments);

  it('resolves Tier 1: same directory as primary file', () => {
    const primary = '/projects/my-ig/input/cql/MainMeasure.cql';
    const existing = new Set([
      j('/projects/my-ig/input/cql', 'MainMeasure.cql'),
      j('/projects/my-ig/input/cql', 'Helper.cql'),
      j('/projects/other', 'Helper.cql'),
    ]);

    const resolved = resolveIncludePath({
      primaryFile: primary,
      libraryName: 'Helper',
      exists: (p) => existing.has(p),
    });

    expect(resolved).to.equal(j('/projects/my-ig/input/cql', 'Helper.cql'));
  });

  it('resolves Tier 2: IG input/cql folder when primary is elsewhere', () => {
    const primary = '/projects/my-ig/input/cql/sub/NestedMeasure.cql';
    const existing = new Set([j('/projects/my-ig/input/cql', 'FHIRHelpers.cql')]);

    const resolved = resolveIncludePath({
      primaryFile: primary,
      libraryName: 'FHIRHelpers',
      exists: (p) => existing.has(p),
    });

    expect(resolved).to.equal(j('/projects/my-ig/input/cql', 'FHIRHelpers.cql'));
  });

  // Each host tests its own native primary-file form (ADR-0003).
  onPosix('native forms', () => {
    it('resolves Tier 2 for a POSIX primary file', () => {
      const expected = '/projects/my-ig/input/cql/FHIRHelpers.cql';
      const resolved = resolveIncludePath({
        primaryFile: '/projects/my-ig/input/cql/sub/NestedMeasure.cql',
        libraryName: 'FHIRHelpers',
        exists: (p) => p === expected,
      });
      expect(resolved).to.equal(expected);
    });
  });
  onWindows('native forms', () => {
    for (const primary of [
      'C:\\projects\\my-ig\\input\\cql\\sub\\NestedMeasure.cql',
      'C:/projects/my-ig/input/cql/sub/NestedMeasure.cql',
    ]) {
      it(`resolves Tier 2 for ${primary}`, () => {
        const expected = 'C:\\projects\\my-ig\\input\\cql\\FHIRHelpers.cql';
        const resolved = resolveIncludePath({
          primaryFile: primary,
          libraryName: 'FHIRHelpers',
          exists: (p) => p === expected,
        });
        expect(resolved).to.equal(expected);
      });
    }
  });

  it('resolves Tier 3: workspace folders when not in local IG directory', () => {
    const primary = '/projects/my-measure/Measure.cql';
    const sharedFolder = '/shared/cql-common';
    const existing = new Set([
      path.join(sharedFolder, 'CommonFunctions.cql'),
    ]);

    const resolved = resolveIncludePath({
      primaryFile: primary,
      libraryName: 'CommonFunctions',
      workspaceFolders: [sharedFolder],
      exists: (p) => existing.has(p),
    });

    expect(resolved).to.equal(path.join(sharedFolder, 'CommonFunctions.cql'));
  });

  it('returns null when library is not on disk (e.g. system modelinfo)', () => {
    const primary = '/projects/my-measure/Measure.cql';
    const resolved = resolveIncludePath({
      primaryFile: primary,
      libraryName: 'FHIRModelInfo',
      exists: () => false,
    });

    expect(resolved).to.be.null;
  });
});
