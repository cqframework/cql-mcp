import { expect } from 'chai';
import * as path from 'node:path';
import { resolveIncludePath } from '../../../src/tools/includeResolver.js';

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

  // A Windows-form primary file is only understood by path.dirname on a Windows host (on POSIX
  // path.dirname doesn't split on backslashes), so this case runs there; the POSIX-form tests above
  // are its counterpart everywhere else.
  (process.platform === 'win32' ? it : it.skip)('resolves Tier 2 for a Windows-form primary file (Windows host)', () => {
    const primary = 'C:\\projects\\my-ig\\input\\cql\\sub\\NestedMeasure.cql';
    const expected = path.win32.join('C:\\projects\\my-ig', 'input', 'cql', 'FHIRHelpers.cql');
    const resolved = resolveIncludePath({
      primaryFile: primary,
      libraryName: 'FHIRHelpers',
      exists: (p) => p === expected,
    });
    expect(resolved).to.equal(expected);
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
