import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { DEFAULT_TEST_CONFIG, type TestConfig } from './testCaseModel.js';

/**
 * If both `config.jsonc` and `config.json` exist in `testDirectoryPath`, prefer `.jsonc`.
 * Falls back to `.json` when only `.json` exists. Returns null if neither exists.
 *
 * Port of vscode-cql/src/helpers/cqlHelpers.ts:32-38 (drops Uri, returns plain string path).
 */
export function resolveTestConfigPath(testDirectoryPath: string): string | null {
  const jsoncPath = path.join(testDirectoryPath, 'config.jsonc');
  if (fs.existsSync(jsoncPath)) {
    return jsoncPath;
  }
  const jsonPath = path.join(testDirectoryPath, 'config.json');
  if (fs.existsSync(jsonPath)) {
    return jsonPath;
  }
  return null;
}

/**
 * Load a TestConfig from disk. Uses jsonc-parser with allowTrailingComma:true and
 * disallowComments:false so comments and trailing commas are tolerated. Falls back
 * to DEFAULT_TEST_CONFIG on missing file or parse error (does not throw).
 *
 * Port of vscode-cql/src/helpers/cqlHelpers.ts:111-134.
 */
export function loadTestConfig(testConfigPath: string | null): TestConfig {
  if (!testConfigPath || !fs.existsSync(testConfigPath)) {
    return DEFAULT_TEST_CONFIG;
  }
  try {
    const text = fs.readFileSync(testConfigPath, 'utf-8');
    const errors: ParseError[] = [];
    const parsed = parseJsonc(text, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    }) as TestConfig | undefined;
    if (errors.length > 0 || !parsed || typeof parsed !== 'object') {
      return DEFAULT_TEST_CONFIG;
    }
    return {
      testCasesToExclude: parsed.testCasesToExclude ?? DEFAULT_TEST_CONFIG.testCasesToExclude,
      parameters: parsed.parameters,
      resultFormat: parsed.resultFormat ?? DEFAULT_TEST_CONFIG.resultFormat,
      flatResultsInSubfolder:
        parsed.flatResultsInSubfolder ?? DEFAULT_TEST_CONFIG.flatResultsInSubfolder,
    };
  } catch {
    return DEFAULT_TEST_CONFIG;
  }
}
