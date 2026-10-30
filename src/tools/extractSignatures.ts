import { formatElmType, ElmTypeSpecifier } from './elmTypeFormatter.js';

export interface ExtractedParameter {
  name: string;
  type: string;
  accessLevel: string;
}

export interface ExtractedDefine {
  name: string;
  returnType: string;
  accessLevel: string;
}

export interface ExtractedFunction {
  name: string;
  accessLevel: string;
  parameters: Array<{ name: string; type: string }>;
  returnType: string;
}

export interface ExtractedValueSet {
  name: string;
  id: string;
  accessLevel?: string;
}

export interface ExtractedCodeSystem {
  name: string;
  id: string;
  accessLevel?: string;
}

export interface ExtractedCode {
  name: string;
  id: string;
  codeSystem?: string;
  accessLevel?: string;
}

export interface ExtractedInclude {
  localIdentifier: string;
  path: string;
  version?: string;
}

export interface ExtractedSignatures {
  library: {
    name?: string;
    version?: string;
  };
  includes: ExtractedInclude[];
  parameters: ExtractedParameter[];
  defines: ExtractedDefine[];
  functions: ExtractedFunction[];
  valueSets: ExtractedValueSet[];
  codeSystems: ExtractedCodeSystem[];
  codes: ExtractedCode[];
}

export interface ExtractSignaturesOptions {
  includePrivate?: boolean;
}

function toArray<T>(item: T | T[] | undefined | null): T[] {
  if (item === undefined || item === null) return [];
  return Array.isArray(item) ? item : [item];
}

interface RawElmStatement {
  name: string;
  type?: string;
  accessLevel?: string;
  resultTypeName?: string;
  resultTypeSpecifier?: ElmTypeSpecifier;
  operand?: Array<{
    name: string;
    operandType?: string;
    operandTypeSpecifier?: ElmTypeSpecifier;
  }>;
}

/**
 * Performs a single-pass extraction of declarations, definitions, and functions from an
 * ELM R1 JSON AST without loading the inner statement expression subtrees.
 *
 * Expects an ELM R1 JSON payload whose root is either `{ library: { ... } }` or the inner library object.
 * Accepts either a JSON-serialized string or a pre-parsed JavaScript object.
 */
export function extractSignatures(
  elmInput: string | Record<string, unknown>,
  options: ExtractSignaturesOptions = {},
): ExtractedSignatures {
  const parsed = typeof elmInput === 'string' ? JSON.parse(elmInput) : elmInput;
  const lib = (parsed?.library ?? parsed) as Record<string, unknown> | undefined;

  const includePrivate = options.includePrivate ?? false;

  // Per HL7 ELM R1 specification: statements, parameters, and terminology definitions
  // with an omitted or undefined `accessLevel` default to 'Public'.
  const isAllowedAccess = (accessLevel?: string): boolean => {
    if (includePrivate) return true;
    const norm = (accessLevel ?? 'Public').toLowerCase();
    return norm === 'public';
  };

  // 1. Library Identifier
  const libIdentifier = (lib?.identifier ?? {}) as { id?: string; version?: string };

  // 2. Includes
  const rawIncludes = toArray((lib?.includes as { def?: unknown })?.def) as Array<{
    localIdentifier?: string;
    path?: string;
    version?: string;
  }>;
  const includes: ExtractedInclude[] = rawIncludes
    .filter((inc) => inc.localIdentifier && inc.path)
    .map((inc) => ({
      localIdentifier: inc.localIdentifier!,
      path: inc.path!,
      version: inc.version,
    }));

  // 3. Parameters
  const rawParams = toArray((lib?.parameters as { def?: unknown })?.def) as Array<{
    name?: string;
    accessLevel?: string;
    resultTypeName?: string;
    resultTypeSpecifier?: ElmTypeSpecifier;
    parameterTypeSpecifier?: ElmTypeSpecifier;
    default?: unknown;
  }>;
  const parameters: ExtractedParameter[] = rawParams
    .filter((p) => p.name && isAllowedAccess(p.accessLevel))
    .map((p) => ({
      name: p.name!,
      accessLevel: p.accessLevel ?? 'Public',
      type: formatElmType(p.parameterTypeSpecifier ?? p.resultTypeSpecifier ?? p.resultTypeName),
    }));

  // 4. Statements (Partitioned into FunctionDef vs ExpressionDef)
  const rawStatements = toArray((lib?.statements as { def?: unknown })?.def) as RawElmStatement[];

  const defines: ExtractedDefine[] = [];
  const functions: ExtractedFunction[] = [];

  for (const stmt of rawStatements) {
    if (!stmt.name || !isAllowedAccess(stmt.accessLevel)) {
      continue;
    }

    const accessLevel = stmt.accessLevel ?? 'Public';
    const returnType = formatElmType(stmt.resultTypeSpecifier ?? stmt.resultTypeName);

    if (stmt.type === 'FunctionDef') {
      const operands = toArray(stmt.operand);
      const params = operands.map((op) => ({
        name: op.name,
        type: formatElmType(op.operandTypeSpecifier ?? op.operandType),
      }));
      functions.push({
        name: stmt.name,
        accessLevel,
        parameters: params,
        returnType,
      });
    } else {
      defines.push({
        name: stmt.name,
        accessLevel,
        returnType,
      });
    }
  }

  // 5. ValueSets
  const rawValueSets = toArray((lib?.valueSets as { def?: unknown })?.def) as Array<{
    name?: string;
    id?: string;
    accessLevel?: string;
  }>;
  const valueSets: ExtractedValueSet[] = rawValueSets
    .filter((vs) => vs.name && vs.id && isAllowedAccess(vs.accessLevel))
    .map((vs) => ({
      name: vs.name!,
      id: vs.id!,
      accessLevel: vs.accessLevel ?? 'Public',
    }));

  // 6. CodeSystems
  const rawCodeSystems = toArray((lib?.codeSystems as { def?: unknown })?.def) as Array<{
    name?: string;
    id?: string;
    accessLevel?: string;
  }>;
  const codeSystems: ExtractedCodeSystem[] = rawCodeSystems
    .filter((cs) => cs.name && cs.id && isAllowedAccess(cs.accessLevel))
    .map((cs) => ({
      name: cs.name!,
      id: cs.id!,
      accessLevel: cs.accessLevel ?? 'Public',
    }));

  // 7. Codes
  const rawCodes = toArray((lib?.codes as { def?: unknown })?.def) as Array<{
    name?: string;
    id?: string;
    codeSystem?: { name?: string };
    accessLevel?: string;
  }>;
  const codes: ExtractedCode[] = rawCodes
    .filter((c) => c.name && c.id && isAllowedAccess(c.accessLevel))
    .map((c) => ({
      name: c.name!,
      id: c.id!,
      codeSystem: c.codeSystem?.name,
      accessLevel: c.accessLevel ?? 'Public',
    }));

  return {
    library: {
      name: libIdentifier.id,
      version: libIdentifier.version,
    },
    includes,
    parameters,
    defines,
    functions,
    valueSets,
    codeSystems,
    codes,
  };
}
