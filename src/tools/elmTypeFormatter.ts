export interface ElmTypeSpecifier {
  type?: string;
  name?: string;
  namespace?: string;
  elementType?: string;
  elementTypeSpecifier?: ElmTypeSpecifier;
  pointType?: string;
  pointTypeSpecifier?: ElmTypeSpecifier;
  element?: Array<{
    name: string;
    type?: ElmTypeSpecifier;
    elementType?: string;
    elementTypeSpecifier?: ElmTypeSpecifier;
  }>;
  choice?: ElmTypeSpecifier[];
}

/**
 * Standard namespace URN to CQL qualifier mapping.
 */
const NAMESPACE_MAP: Record<string, string> = {
  'urn:hl7-org:elm-types:r1': 'System',
  'http://hl7.org/fhir': 'FHIR',
  'http://hl7.org/fhir/4.0.1': 'FHIR',
  'http://hl7.org/fhir/us/core': 'USCore',
  'http://hl7.org/fhir/us/qicore': 'QICore',
};

function formatNamespace(ns?: string): string {
  if (!ns) return '';
  return NAMESPACE_MAP[ns] ?? ns;
}

/**
 * Formats a QName string like "{urn:hl7-org:elm-types:r1}Boolean" or "{http://hl7.org/fhir}Encounter"
 * into a CQL type signature like "System.Boolean" or "FHIR.Encounter".
 */
export function formatQName(qname: string): string {
  const match = /^\{([^}]+)\}(.+)$/.exec(qname);
  if (match) {
    const rawNs = match[1]!;
    const name = match[2]!;
    const prefix = formatNamespace(rawNs);
    return prefix ? `${prefix}.${name}` : name;
  }
  return qname;
}

/**
 * Formats an ELM type representation (either an ELM TypeSpecifier object or a QName string)
 * into an idiomatic CQL type signature string.
 */
export function formatElmType(rawType?: string | ElmTypeSpecifier | null): string {
  if (!rawType) {
    return 'System.Any';
  }

  if (typeof rawType === 'string') {
    return formatQName(rawType);
  }

  const spec = rawType;
  const specType = spec.type;

  switch (specType) {
    case 'NamedTypeSpecifier':
    case 'ClassTypeSpecifier': {
      if (spec.namespace && spec.name) {
        const prefix = formatNamespace(spec.namespace);
        return prefix ? `${prefix}.${spec.name}` : spec.name;
      }
      if (spec.name) {
        return formatQName(spec.name);
      }
      return 'System.Any';
    }

    case 'ListTypeSpecifier': {
      const inner = spec.elementTypeSpecifier ?? spec.elementType;
      return `List<${formatElmType(inner)}>`;
    }

    case 'IntervalTypeSpecifier': {
      const inner = spec.pointTypeSpecifier ?? spec.pointType;
      return `Interval<${formatElmType(inner)}>`;
    }

    case 'TupleTypeSpecifier': {
      if (!spec.element || spec.element.length === 0) {
        return 'Tuple {}';
      }
      const fields = spec.element.map((el) => {
        const fieldType = el.elementTypeSpecifier ?? el.type ?? el.elementType;
        return `${el.name}: ${formatElmType(fieldType)}`;
      });
      return `Tuple { ${fields.join(', ')} }`;
    }

    case 'ChoiceTypeSpecifier': {
      if (!spec.choice || spec.choice.length === 0) {
        return 'Choice';
      }
      const choices = spec.choice.map((c) => formatElmType(c));
      return `Choice<${choices.join(', ')}>`;
    }

    default: {
      if (spec.name) {
        return formatQName(spec.name);
      }
      return specType ?? 'System.Any';
    }
  }
}
