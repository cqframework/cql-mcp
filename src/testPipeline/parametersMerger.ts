import type {
  CqlParametersConfig,
  LibraryParameterBlock,
  ParameterEntry,
  ParameterSource,
} from './testCaseModel.js';

/**
 * Merges three parameter lists with increasing priority: global < library < testCase.
 * When multiple entries share the same name, the highest-priority entry wins (last-write-wins).
 *
 * Faithful port of vscode-cql/src/helpers/parametersHelper.ts:12-22.
 */
export function mergeParameters(
  global: ParameterEntry[],
  libraryParams: ParameterEntry[],
  testCaseParams: ParameterEntry[],
): ParameterEntry[] {
  const merged = new Map<string, ParameterEntry>();
  for (const p of [...global, ...libraryParams, ...testCaseParams]) {
    merged.set(p.name, p);
  }
  return Array.from(merged.values());
}

/**
 * Resolves the effective parameters for a specific library + version + patient by applying
 * the merge priority: global → library → testCase.
 *
 * Library blocks are matched by name. If a block specifies `version`, it only applies when
 * `libraryVersion` matches exactly. Blocks without `version` apply to any version.
 *
 * **Quirk inherited from the extension (parametersHelper.ts:45-49):** matching library blocks
 * are concatenated in array order, not by specificity. When a config defines BOTH a
 * version-pinned block AND a version-less block for the same library, their `parameters` arrays
 * are concatenated in the order they appear in the config, and `mergeParameters` last-write-wins
 * on name. This behavior is reproduced verbatim — do NOT silently "fix" it. Documented as an
 * intentional behavior match with the editor.
 *
 * Faithful port of vscode-cql/src/helpers/parametersHelper.ts:31-64.
 */
export function resolveParameters(
  config: CqlParametersConfig,
  libraryName: string,
  libraryVersion: string | undefined,
  patientId: string | undefined,
): ParameterEntry[] {
  const tag = (entries: ParameterEntry[], source: ParameterSource): ParameterEntry[] =>
    entries.map((p) => ({ ...p, source }));

  const global = tag(
    config.filter((e): e is ParameterEntry => !('library' in e)),
    'config-global',
  );

  const matchingBlocks = config
    .filter((e): e is LibraryParameterBlock => 'library' in e)
    .filter(
      (b) =>
        b.library === libraryName &&
        (b.version == null || b.version === libraryVersion),
    );

  const library = tag(
    matchingBlocks.flatMap((b) => b.parameters ?? []),
    'config-library',
  );

  const testCase = patientId
    ? tag(
        matchingBlocks.flatMap((b) => b.testCases?.[patientId] ?? []),
        'config-test-case',
      )
    : [];

  return mergeParameters(global, library, testCase);
}
