import { expect } from 'chai';
import { formatElmType, formatQName } from '../../../src/tools/elmTypeFormatter.js';

describe('tools/elmTypeFormatter', () => {
  describe('formatQName', () => {
    it('formats System primitive QNames', () => {
      expect(formatQName('{urn:hl7-org:elm-types:r1}Boolean')).to.equal('System.Boolean');
      expect(formatQName('{urn:hl7-org:elm-types:r1}Integer')).to.equal('System.Integer');
      expect(formatQName('{urn:hl7-org:elm-types:r1}DateTime')).to.equal('System.DateTime');
    });

    it('formats FHIR model QNames', () => {
      expect(formatQName('{http://hl7.org/fhir}Encounter')).to.equal('FHIR.Encounter');
      expect(formatQName('{http://hl7.org/fhir/4.0.1}Patient')).to.equal('FHIR.Patient');
    });

    it('passes through unprefixed strings', () => {
      expect(formatQName('CustomType')).to.equal('CustomType');
    });
  });

  describe('formatElmType', () => {
    it('defaults null/undefined to System.Any', () => {
      expect(formatElmType(undefined)).to.equal('System.Any');
      expect(formatElmType(null)).to.equal('System.Any');
    });

    it('formats string types directly', () => {
      expect(formatElmType('{urn:hl7-org:elm-types:r1}String')).to.equal('System.String');
    });

    it('formats NamedTypeSpecifier with namespace and name', () => {
      expect(
        formatElmType({
          type: 'NamedTypeSpecifier',
          namespace: 'urn:hl7-org:elm-types:r1',
          name: 'Boolean',
        }),
      ).to.equal('System.Boolean');

      expect(
        formatElmType({
          type: 'NamedTypeSpecifier',
          name: '{urn:hl7-org:elm-types:r1}Decimal',
        }),
      ).to.equal('System.Decimal');
    });

    it('formats ClassTypeSpecifier for FHIR classes', () => {
      expect(
        formatElmType({
          type: 'ClassTypeSpecifier',
          namespace: 'http://hl7.org/fhir',
          name: 'Observation',
        }),
      ).to.equal('FHIR.Observation');
    });

    it('formats ListTypeSpecifier recursively', () => {
      expect(
        formatElmType({
          type: 'ListTypeSpecifier',
          elementTypeSpecifier: {
            type: 'ClassTypeSpecifier',
            namespace: 'http://hl7.org/fhir',
            name: 'Encounter',
          },
        }),
      ).to.equal('List<FHIR.Encounter>');

      // Fallback with elementType string
      expect(
        formatElmType({
          type: 'ListTypeSpecifier',
          elementType: '{urn:hl7-org:elm-types:r1}String',
        }),
      ).to.equal('List<System.String>');
    });

    it('formats IntervalTypeSpecifier recursively', () => {
      expect(
        formatElmType({
          type: 'IntervalTypeSpecifier',
          pointTypeSpecifier: {
            type: 'NamedTypeSpecifier',
            namespace: 'urn:hl7-org:elm-types:r1',
            name: 'DateTime',
          },
        }),
      ).to.equal('Interval<System.DateTime>');
    });

    it('formats TupleTypeSpecifier with field names and types', () => {
      expect(
        formatElmType({
          type: 'TupleTypeSpecifier',
          element: [
            {
              name: 'period',
              elementTypeSpecifier: {
                type: 'IntervalTypeSpecifier',
                pointTypeSpecifier: {
                  type: 'NamedTypeSpecifier',
                  namespace: 'urn:hl7-org:elm-types:r1',
                  name: 'DateTime',
                },
              },
            },
            {
              name: 'count',
              elementType: '{urn:hl7-org:elm-types:r1}Integer',
            },
          ],
        }),
      ).to.equal('Tuple { period: Interval<System.DateTime>, count: System.Integer }');
    });

    it('formats ChoiceTypeSpecifier with multiple alternative types', () => {
      expect(
        formatElmType({
          type: 'ChoiceTypeSpecifier',
          choice: [
            {
              type: 'NamedTypeSpecifier',
              namespace: 'urn:hl7-org:elm-types:r1',
              name: 'Boolean',
            },
            {
              type: 'NamedTypeSpecifier',
              namespace: 'urn:hl7-org:elm-types:r1',
              name: 'Integer',
            },
          ],
        }),
      ).to.equal('Choice<System.Boolean, System.Integer>');
    });
  });
});
