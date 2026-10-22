import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  MeasureReportData,
  MeasureReportPopulation,
  TestCase,
} from './testCaseModel.js';

const DESCRIPTION_URL =
  'http://hl7.org/fhir/us/cqfmeasures/StructureDefinition/cqfm-testCaseDescription';

/**
 * Strip markdown formatting, control chars, and stray quotes from a description.
 * Port of vscode-cql/src/model/testCase.ts:103-111 (sans markdown-to-text dep — we
 * apply the same regex normalization inline).
 */
export function sanitizeDescription(raw: string): string {
  return raw
    .replace(/[*_`#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[\r\n\x00-\x1F\x7F]/g, ' ')
    .replace(/  +/g, ' ')
    .trim()
    .replace(/^"+|"+$/g, '')
    .trim();
}

function extractTestCaseDescription(report: Record<string, unknown>): string | undefined {
  const extensions = report['extension'] as Array<Record<string, unknown>> | undefined;
  const ext = extensions?.find((e) => e['url'] === DESCRIPTION_URL);
  const raw = ext?.['valueMarkdown'] as string | undefined;
  return raw ? sanitizeDescription(raw) : undefined;
}

function extractPatientId(report: Record<string, unknown>): string | undefined {
  const contained = report['contained'] as Array<Record<string, unknown>> | undefined;
  const params = contained?.find((r) => r['resourceType'] === 'Parameters');
  const parameter = params?.['parameter'] as Array<Record<string, unknown>> | undefined;
  const subject = parameter?.find((p) => p['name'] === 'subject');
  return subject?.['valueString'] as string | undefined;
}

function extractPopulations(
  report: Record<string, unknown>,
): MeasureReportPopulation[] | undefined {
  const groups = report['group'] as Array<Record<string, unknown>> | undefined;
  if (!groups) {
    return undefined;
  }
  return groups.flatMap((group) => {
    const groupId = group['id'] as string;
    const pops = group['population'] as Array<Record<string, unknown>> | undefined;
    if (!pops) {
      return [];
    }
    return pops.map((pop) => {
      const coding = (
        (pop['code'] as Record<string, unknown> | undefined)?.['coding'] as
          | Array<Record<string, unknown>>
          | undefined
      )?.[0];
      return {
        groupId,
        display: (coding?.['display'] as string) ?? '',
        expected: (pop['count'] as number) ?? 0,
        code: (coding?.['code'] as string) ?? '',
      };
    });
  });
}

/**
 * Read the first `MeasureReport*.json` in a test-case directory and extract
 * structured data: patient ID, expected population counts per group, and the
 * test case description (markdown-stripped).
 *
 * Returns undefined if the directory doesn't exist or has no MeasureReport.
 *
 * Port of vscode-cql/src/model/testCase.ts:72-101.
 */
export function getMeasureReportData(testCaseFolderPath: string): MeasureReportData | undefined {
  try {
    if (!fs.existsSync(testCaseFolderPath)) {
      return undefined;
    }
    const measureReportFile = fs
      .readdirSync(testCaseFolderPath)
      .find((f) => f.startsWith('MeasureReport'));
    if (!measureReportFile) {
      return undefined;
    }
    const content = fs.readFileSync(
      path.join(testCaseFolderPath, measureReportFile),
      'utf-8',
    );
    const report = JSON.parse(content) as Record<string, unknown>;
    return {
      patientId: extractPatientId(report),
      populations: extractPopulations(report),
      description: extractTestCaseDescription(report),
    };
  } catch {
    return undefined;
  }
}

/**
 * Discover test cases under `<suiteRoot>/<libraryName>/`.
 *
 * Layout A (extension convention — see vscode-cql/src/model/testCase.ts:25-51):
 *   <suiteRoot>/<libraryName>/<patient-uuid-dir>/{Patient-*.json, Encounter-*.json, MeasureReport-*.json, ...}
 *   <suiteRoot>/<libraryName>/shared/   ← real sibling dir, always excluded
 *
 * `excludedDirs` is the union of config-supplied testCasesToExclude + tool-supplied
 * excludeTestCases + the literal 'shared'. Each entry is a directory name (compared
 * case-sensitively, matching the extension's behavior at testCase.ts:41).
 *
 * Returns an empty array if suiteRoot or the library subdirectory does not exist.
 */
export function loadSuite(
  suiteRoot: string,
  libraryName: string,
  excludedDirs: ReadonlySet<string>,
): TestCase[] {
  const libraryDir = path.join(suiteRoot, libraryName);
  if (!fs.existsSync(libraryDir)) {
    return [];
  }
  const result: TestCase[] = [];
  for (const entry of fs.readdirSync(libraryDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === 'shared') {
      continue;
    }
    if (excludedDirs.has(entry.name)) {
      continue;
    }
    result.push({
      name: entry.name,
      path: path.join(libraryDir, entry.name),
    });
  }
  return result;
}

/**
 * Build the union of exclusion sets: 'shared' + every name in `excludedDirs`.
 * Caller passes the union to `loadSuite`.
 */
export function buildExclusionSet(...sources: ReadonlyArray<Iterable<string>>): Set<string> {
  const out = new Set<string>(['shared']);
  for (const src of sources) {
    for (const name of src) {
      out.add(name);
    }
  }
  return out;
}
