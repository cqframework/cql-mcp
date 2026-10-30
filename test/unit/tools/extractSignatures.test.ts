import { expect } from 'chai';
import { extractSignatures } from '../../../src/tools/extractSignatures.js';

describe('tools/extractSignatures', () => {
  const sampleElm = {
    library: {
      identifier: {
        id: 'TestMeasure',
        version: '1.0.0',
      },
      includes: {
        def: [
          { localIdentifier: 'FHIRHelpers', path: 'FHIRHelpers', version: '4.0.1' },
          { localIdentifier: 'Global', path: 'MATGlobalCommonFunctionsFHIR4', version: '6.1.000' },
        ],
      },
      parameters: {
        def: [
          {
            name: 'Measurement Period',
            accessLevel: 'Public',
            parameterTypeSpecifier: {
              type: 'IntervalTypeSpecifier',
              pointTypeSpecifier: {
                type: 'NamedTypeSpecifier',
                namespace: 'urn:hl7-org:elm-types:r1',
                name: 'DateTime',
              },
            },
          },
          {
            name: 'InternalParam',
            accessLevel: 'Private',
            parameterTypeSpecifier: {
              type: 'NamedTypeSpecifier',
              namespace: 'urn:hl7-org:elm-types:r1',
              name: 'Integer',
            },
          },
        ],
      },
      codeSystems: {
        def: [
          {
            name: 'SNOMEDCT',
            id: 'http://snomed.info/sct',
            accessLevel: 'Public',
          },
        ],
      },
      valueSets: {
        def: [
          {
            name: 'Inpatient Encounter',
            id: 'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.666.5.307',
            accessLevel: 'Public',
          },
          {
            name: 'PrivateValueSet',
            id: 'http://example.com/vs',
            accessLevel: 'Private',
          },
        ],
      },
      codes: {
        def: [
          {
            name: 'Encounter Inpatient',
            id: '183452005',
            codeSystem: { name: 'SNOMEDCT' },
            accessLevel: 'Public',
          },
        ],
      },
      statements: {
        def: [
          {
            name: 'Qualifying Encounters',
            accessLevel: 'Public',
            resultTypeSpecifier: {
              type: 'ListTypeSpecifier',
              elementTypeSpecifier: {
                type: 'ClassTypeSpecifier',
                namespace: 'http://hl7.org/fhir',
                name: 'Encounter',
              },
            },
            expression: {
              type: 'Query',
              where: { type: 'Literal', value: true },
            },
          },
          {
            name: 'PrivateHelper',
            accessLevel: 'Private',
            resultTypeName: '{urn:hl7-org:elm-types:r1}Boolean',
            expression: { type: 'Literal', value: true },
          },
          {
            name: 'HospitalizationWithObservation',
            type: 'FunctionDef',
            accessLevel: 'Public',
            operand: [
              {
                name: 'TheEncounter',
                operandTypeSpecifier: {
                  type: 'ClassTypeSpecifier',
                  namespace: 'http://hl7.org/fhir',
                  name: 'Encounter',
                },
              },
            ],
            resultTypeSpecifier: {
              type: 'IntervalTypeSpecifier',
              pointTypeSpecifier: {
                type: 'NamedTypeSpecifier',
                namespace: 'urn:hl7-org:elm-types:r1',
                name: 'DateTime',
              },
            },
            expression: { type: 'Interval' },
          },
        ],
      },
    },
  };

  it('partitions statements.def into defines and functions and ignores AST expression bodies', () => {
    const res = extractSignatures(sampleElm, { includePrivate: false });

    expect(res.library).to.deep.equal({ name: 'TestMeasure', version: '1.0.0' });

    expect(res.includes).to.deep.equal([
      { localIdentifier: 'FHIRHelpers', path: 'FHIRHelpers', version: '4.0.1' },
      { localIdentifier: 'Global', path: 'MATGlobalCommonFunctionsFHIR4', version: '6.1.000' },
    ]);

    expect(res.parameters).to.deep.equal([
      { name: 'Measurement Period', accessLevel: 'Public', type: 'Interval<System.DateTime>' },
    ]);

    expect(res.defines).to.deep.equal([
      { name: 'Qualifying Encounters', accessLevel: 'Public', returnType: 'List<FHIR.Encounter>' },
    ]);

    expect(res.functions).to.deep.equal([
      {
        name: 'HospitalizationWithObservation',
        accessLevel: 'Public',
        parameters: [{ name: 'TheEncounter', type: 'FHIR.Encounter' }],
        returnType: 'Interval<System.DateTime>',
      },
    ]);

    expect(res.valueSets).to.deep.equal([
      {
        name: 'Inpatient Encounter',
        id: 'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.666.5.307',
        accessLevel: 'Public',
      },
    ]);

    expect(res.codeSystems).to.deep.equal([
      { name: 'SNOMEDCT', id: 'http://snomed.info/sct', accessLevel: 'Public' },
    ]);

    expect(res.codes).to.deep.equal([
      { name: 'Encounter Inpatient', id: '183452005', codeSystem: 'SNOMEDCT', accessLevel: 'Public' },
    ]);
  });

  it('includes private definitions when includePrivate: true', () => {
    const res = extractSignatures(sampleElm, { includePrivate: true });

    expect(res.parameters.map((p) => p.name)).to.include('InternalParam');
    expect(res.defines.map((d) => d.name)).to.include('PrivateHelper');
    expect(res.valueSets.map((v) => v.name)).to.include('PrivateValueSet');
  });

  it('handles JSON string inputs', () => {
    const jsonStr = JSON.stringify(sampleElm);
    const res = extractSignatures(jsonStr);
    expect(res.defines).to.have.length(1);
    expect(res.defines[0]?.name).to.equal('Qualifying Encounters');
  });
});
