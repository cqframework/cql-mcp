import { expect } from 'chai';
import { mergeParameters, resolveParameters } from '../../../src/testPipeline/parametersMerger.js';
import type { CqlParametersConfig, ParameterEntry } from '../../../src/testPipeline/testCaseModel.js';

function entry(name: string, value: string): ParameterEntry {
  return { name, type: 'String', value };
}

describe('testPipeline/parametersMerger', () => {
  describe('mergeParameters', () => {
    it('returns empty array when all inputs are empty', () => {
      expect(mergeParameters([], [], [])).to.deep.equal([]);
    });

    it('preserves global-only entries', () => {
      const result = mergeParameters([entry('A', 'global-A')], [], []);
      expect(result).to.have.length(1);
      expect(result[0]).to.deep.include({ name: 'A', value: 'global-A' });
    });

    it('library overrides global on duplicate name (last-write-wins)', () => {
      const result = mergeParameters(
        [entry('A', 'global-A')],
        [entry('A', 'library-A')],
        [],
      );
      expect(result).to.have.length(1);
      expect(result[0]).to.deep.include({ name: 'A', value: 'library-A' });
    });

    it('testCase overrides library overrides global', () => {
      const result = mergeParameters(
        [entry('A', 'global-A')],
        [entry('A', 'library-A')],
        [entry('A', 'testCase-A')],
      );
      expect(result).to.have.length(1);
      expect(result[0]).to.deep.include({ name: 'A', value: 'testCase-A' });
    });

    it('dedup keeps only the highest-priority entry per name', () => {
      const result = mergeParameters(
        [entry('A', 'g'), entry('B', 'g'), entry('C', 'g')],
        [entry('B', 'l')],
        [entry('C', 't')],
      );
      expect(result).to.have.length(3);
      const byName = Object.fromEntries(result.map((p) => [p.name, p.value]));
      expect(byName).to.deep.equal({ A: 'g', B: 'l', C: 't' });
    });

    it('does not merge entries with different names (all preserved)', () => {
      const result = mergeParameters(
        [entry('A', '1')],
        [entry('B', '2')],
        [entry('C', '3')],
      );
      expect(result.map((p) => p.name).sort()).to.deep.equal(['A', 'B', 'C']);
    });
  });

  describe('resolveParameters', () => {
    it('returns global-only when no library blocks match', () => {
      const config: CqlParametersConfig = [
        entry('G1', '1'),
        { library: 'OtherLibrary', parameters: [entry('L1', 'should-not-apply')] },
      ];
      const result = resolveParameters(config, 'MyLib', '1.0.0', 'patient-1');
      expect(result.map((p) => p.name).sort()).to.deep.equal(['G1']);
    });

    it('applies library block when library name matches', () => {
      const config: CqlParametersConfig = [
        entry('G1', 'global'),
        { library: 'MyLib', parameters: [entry('L1', 'library')] },
      ];
      const result = resolveParameters(config, 'MyLib', '1.0.0', 'patient-1');
      const byName = Object.fromEntries(result.map((p) => [p.name, p.value]));
      expect(byName).to.deep.equal({ G1: 'global', L1: 'library' });
      expect(result.find((p) => p.name === 'L1')?.source).to.equal('config-library');
    });

    it('version-pinned block only applies at the exact version', () => {
      const config: CqlParametersConfig = [
        { library: 'MyLib', version: '1.0.0', parameters: [entry('V', 'pinned-1.0.0')] },
      ];
      const at = resolveParameters(config, 'MyLib', '1.0.0', undefined);
      const not = resolveParameters(config, 'MyLib', '2.0.0', undefined);
      expect(at.find((p) => p.name === 'V')?.value).to.equal('pinned-1.0.0');
      expect(not).to.have.length(0);
    });

    it('version-less block applies regardless of version', () => {
      const config: CqlParametersConfig = [
        { library: 'MyLib', parameters: [entry('V', 'any-version')] },
      ];
      expect(resolveParameters(config, 'MyLib', '1.0.0', undefined)[0].value).to.equal('any-version');
      expect(resolveParameters(config, 'MyLib', '99.0.0', undefined)[0].value).to.equal('any-version');
    });

    it('per-testCase overrides library', () => {
      const config: CqlParametersConfig = [
        {
          library: 'MyLib',
          parameters: [entry('P', 'lib')],
          testCases: { 'patient-1': [entry('P', 'case-1')] },
        },
      ];
      const result = resolveParameters(config, 'MyLib', '1.0.0', 'patient-1');
      expect(result.find((p) => p.name === 'P')?.value).to.equal('case-1');
      expect(result.find((p) => p.name === 'P')?.source).to.equal('config-test-case');
    });

    it('per-testCase block is ignored when patientId is undefined', () => {
      const config: CqlParametersConfig = [
        {
          library: 'MyLib',
          parameters: [entry('P', 'lib')],
          testCases: { 'patient-1': [entry('P', 'case-1')] },
        },
      ];
      const result = resolveParameters(config, 'MyLib', '1.0.0', undefined);
      expect(result.find((p) => p.name === 'P')?.value).to.equal('lib');
    });

    it('inherited quirk: version-pinned block before version-less block → version-less wins (last-write-wins in array order)', () => {
      // parametersHelper.ts:45-49 concatenates matching blocks in array order,
      // then mergeParameters last-write-wins. So this config yields version-less
      // values for matching version because the version-less block is later.
      const config: CqlParametersConfig = [
        { library: 'MyLib', version: '1.0.0', parameters: [entry('P', 'pinned')] },
        { library: 'MyLib', parameters: [entry('P', 'unpinned')] },
      ];
      const result = resolveParameters(config, 'MyLib', '1.0.0', undefined);
      expect(result.find((p) => p.name === 'P')?.value).to.equal('unpinned');
    });

    it('inherited quirk: version-pinned block after version-less block → version-pinned wins', () => {
      const config: CqlParametersConfig = [
        { library: 'MyLib', parameters: [entry('P', 'unpinned')] },
        { library: 'MyLib', version: '1.0.0', parameters: [entry('P', 'pinned')] },
      ];
      const result = resolveParameters(config, 'MyLib', '1.0.0', undefined);
      expect(result.find((p) => p.name === 'P')?.value).to.equal('pinned');
    });

    it('sources are tagged correctly across tiers', () => {
      const config: CqlParametersConfig = [
        entry('G', 'g'),
        { library: 'MyLib', parameters: [entry('L', 'l')], testCases: { p1: [entry('T', 't')] } },
      ];
      const result = resolveParameters(config, 'MyLib', '1.0.0', 'p1');
      const sources = Object.fromEntries(result.map((p) => [p.name, p.source]));
      expect(sources).to.deep.equal({ G: 'config-global', L: 'config-library', T: 'config-test-case' });
    });
  });
});
