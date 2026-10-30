import { expect } from 'chai';
import * as path from 'node:path';
import { resolveIncludePath } from '../../../src/tools/includeResolver.js';

describe('tools/includeResolver', () => {
  it('resolves Tier 1: same directory as primary file', () => {
    const primary = '/projects/my-ig/input/cql/MainMeasure.cql';
    const existing = new Set([
      '/projects/my-ig/input/cql/MainMeasure.cql',
      '/projects/my-ig/input/cql/Helper.cql',
      '/projects/other/Helper.cql',
    ]);

    const resolved = resolveIncludePath({
      primaryFile: primary,
      libraryName: 'Helper',
      exists: (p) => existing.has(p),
    });

    expect(resolved).to.equal('/projects/my-ig/input/cql/Helper.cql');
  });

  it('resolves Tier 2: IG input/cql folder when primary is elsewhere', () => {
    const primary = '/projects/my-ig/input/cql/sub/NestedMeasure.cql';
    const existing = new Set([
      '/projects/my-ig/input/cql/FHIRHelpers.cql',
    ]);

    const resolved = resolveIncludePath({
      primaryFile: primary,
      libraryName: 'FHIRHelpers',
      exists: (p) => existing.has(p),
    });

    expect(resolved).to.equal('/projects/my-ig/input/cql/FHIRHelpers.cql');
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
