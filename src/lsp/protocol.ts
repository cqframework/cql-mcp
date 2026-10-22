export interface ParameterRequest {
  parameterName: string;
  parameterType: string;
  parameterValue: string;
}

export interface LibraryRequest {
  libraryName: string;
  libraryUri: string;
  libraryVersion: string | null;
  terminologyUri: string | null;
  model: { modelName: string; modelUri: string } | null;
  context: { contextName: string; contextValue: string } | null;
  parameters: ParameterRequest[];
}

export interface ExecuteCqlRequest {
  fhirVersion: string;
  rootDir: string | null;
  optionsPath: string | null;
  libraries: LibraryRequest[];
}

export interface ExpressionResult {
  name: string;
  value: string;
}

export interface UsedDefaultParameter {
  name: string;
  value: string;
  source: string;
}

export interface LibraryResult {
  libraryName: string;
  expressions: ExpressionResult[];
  usedDefaultParameters?: UsedDefaultParameter[];
}

export interface VersionInfo {
  languageServer?: string;
  translator?: string;
  clinicalReasoning?: string;
  engine?: string;
  cql?: string;
  elm?: string;
  [key: string]: string | undefined;
}

export interface ExecuteCqlResponse {
  results: LibraryResult[];
  logs: string[];
  versions?: VersionInfo;
}