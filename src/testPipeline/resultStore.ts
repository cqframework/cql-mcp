import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { RunRecord, RunSummary } from './testCaseModel.js';
import {
  latestPointerPath,
  previousPointerPath,
  runRecordPath,
  runStoreDir,
} from '../workspace/paths.js';

/**
 * Deterministic SHA-256 content hash over canonical JSON of the given object.
 * Object keys are sorted recursively; arrays are sorted (by their canonical
 * JSON representation) before serialization, so two arrays with the same
 * elements in different orders produce the same hash. Two runs with identical
 * inputs produce identical hashes; identical hashes at different timestamps
 * are saved as separate files (plain accumulation).
 */
export function contentHash(input: Record<string, unknown>): string {
  const canonical = canonicalize(input);
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + canonicalSortArray(value).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]));
  return '{' + parts.join(',') + '}';
}

/**
 * Order-insensitive array canonicalization: sort elements by their canonical
 * JSON form so that two arrays with identical contents in different orders
 * produce the same hash. Centralizes what was previously a one-off `.sort()`
 * at the contextValues call site in suiteRunner.
 */
function canonicalSortArray(arr: unknown[]): string[] {
  return arr.map(canonicalize).sort();
}

function ensureStoreDir(rootDir: string): string {
  const dir = runStoreDir(rootDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Persist a run record. Plain accumulation: every call writes a new file
 * (no overwrite, even if the content hash matches a prior run). Returns the
 * absolute path of the written file.
 */
export function saveRun(rootDir: string, run: RunRecord): string {
  ensureStoreDir(rootDir);
  const filePath = runRecordPath(rootDir, run.timestamp, run.hash);
  fs.writeFileSync(filePath, JSON.stringify(run, null, 2), 'utf-8');
  return filePath;
}

/**
 * Rotate the per-suite pointers: existing `latest-<suite>.json` (if any) is
 * copied to `previous-<suite>.json`, then a new `latest-<suite>.json` is
 * written pointing at `hash`.
 *
 * Idempotent: calling twice without an intervening saveRun produces the same
 * pointer state.
 */
export function updatePointers(rootDir: string, suiteName: string, hash: string): void {
  ensureStoreDir(rootDir);
  const latest = latestPointerPath(rootDir, suiteName);
  const previous = previousPointerPath(rootDir, suiteName);
  if (fs.existsSync(latest)) {
    const oldContent = fs.readFileSync(latest, 'utf-8');
    fs.writeFileSync(previous, oldContent, 'utf-8');
  }
  fs.writeFileSync(latest, JSON.stringify({ hash }), 'utf-8');
}

interface PointerRecord {
  hash: string;
}

/** Read the latest pointer for a suite. Returns null if missing or malformed. */
export function readLatestPointer(rootDir: string, suiteName: string): PointerRecord | null {
  return readPointerFile(latestPointerPath(rootDir, suiteName));
}

/** Read the previous pointer for a suite. Returns null if missing or malformed. */
export function readPreviousPointer(rootDir: string, suiteName: string): PointerRecord | null {
  return readPointerFile(previousPointerPath(rootDir, suiteName));
}

/**
 * Shared pointer-read helper. Returns null on ENOENT (file missing) or on
 * malformed JSON. Other fs errors (EACCES, EMFILE, transient races) are
 * propagated so callers don't silently lose the pointer due to an unrelated
 * filesystem problem.
 */
function readPointerFile(filePath: string): PointerRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as PointerRecord;
    return typeof parsed.hash === 'string' ? parsed : null;
  } catch {
    return null; // malformed JSON → treat as missing
  }
}

/**
 * Run-record filenames have the strict shape `<timestamp>-<hash8>.json`.
 * Pointer files (`latest-*`, `previous-*`) are excluded. The regex captures
 * the timestamp and the 8-char hex hash separately so a substring match can
 * never cross the boundary (timestamps are all-digit and can coincidentally
 * contain a hash prefix substring).
 */
const RUN_FILE_RE = /^(.*)-([0-9a-fA-F]{8})\.json$/;

export class AmbiguousRunRefError extends Error {
  constructor(
    public readonly ref: string,
    public readonly matches: Array<{ timestamp: string; hash8: string; fullHash: string }>,
  ) {
    super(
      `Ambiguous hash prefix "${ref}" matches ${matches.length} runs: ` +
        matches.map((m) => `${m.timestamp}-${m.hash8}`).join(', '),
    );
    this.name = 'AmbiguousRunRefError';
  }
}

/**
 * Load a run record by hash (full 64-char SHA or any prefix) or full ISO
 * timestamp. Matching is strict:
 * - For a hex hash input, the run's filename 8-char prefix must start with
 *   the input (using input.slice(0, 8) for full hashes, or as-is for shorter
 *   prefixes). If multiple files match a short prefix, throw
 *   `AmbiguousRunRefError`. If multiple match a full 64-char hash (i.e. two
 *   runs share the same 8-char prefix), disambiguate by parsing each candidate
 *   and comparing its stored `run.hash` field for exact equality.
 * - For a non-hex (ISO timestamp) input, match by exact timestamp prefix on
 *   the captured timestamp group.
 *
 * Returns null if no match found.
 */
export function loadRun(
  rootDir: string,
  hashOrTimestamp: string,
): RunRecord | null {
  const dir = runStoreDir(rootDir);
  if (!fs.existsSync(dir)) {
    return null;
  }

  const isHex = /^[0-9a-f]+$/i.test(hashOrTimestamp);
  const needle8 = isHex ? hashOrTimestamp.slice(0, 8).toLowerCase() : null;
  const isFullHash = isHex && hashOrTimestamp.length === 64;

  const candidates: Array<{ file: string; timestamp: string; hash8: string; parsed: RunRecord }> = [];
  for (const file of fs.readdirSync(dir)) {
    const m = RUN_FILE_RE.exec(file);
    if (!m) {
      continue; // pointer files and anything not matching the run shape
    }
    const [, timestamp, hash8] = m;
    if (isHex) {
      if (!hash8.toLowerCase().startsWith(needle8!)) {
        continue;
      }
    } else {
      if (!timestamp.startsWith(hashOrTimestamp)) {
        continue;
      }
    }
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as RunRecord;
    candidates.push({ file, timestamp, hash8: hash8.toLowerCase(), parsed });
  }

  if (candidates.length === 0) {
    return null;
  }

  // For a full 64-char hash, disambiguate by stored run.hash equality — that
  // field is the full SHA-256 (populated by contentHash in suiteRunner).
  if (isFullHash) {
    const exact = candidates.find((c) => c.parsed.hash.toLowerCase() === hashOrTimestamp.toLowerCase());
    if (exact) {
      return exact.parsed;
    }
    // Fall through to ambiguous-prefix path if no candidate's stored hash
    // actually matches (e.g. the prefix was a coincidental substring hit).
  }

  if (candidates.length > 1) {
    throw new AmbiguousRunRefError(
      hashOrTimestamp,
      candidates.map((c) => ({ timestamp: c.timestamp, hash8: c.hash8, fullHash: c.parsed.hash })),
    );
  }
  return candidates[0].parsed;
}

/**
 * List all run records under `<rootDir>/.cql-debug/test-runs/`, newest-first.
 * Optionally filtered by suite name.
 */
export function listRuns(
  rootDir: string,
  opts: { suiteName?: string; limit?: number } = {},
): RunSummary[] {
  const dir = runStoreDir(rootDir);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const all: RunSummary[] = [];
  for (const file of fs.readdirSync(dir)) {
    const m = RUN_FILE_RE.exec(file);
    if (!m) {
      continue;
    }
    const full = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as RunRecord;
    if (opts.suiteName && full.suiteName !== opts.suiteName) {
      continue;
    }
    all.push({
      timestamp: full.timestamp,
      hash: full.hash,
      suiteName: full.suiteName,
      libraryName: full.libraryName,
      testCaseCount: full.counts.total,
      passed: full.counts.passed,
      failed: full.counts.failed,
      passRate: full.counts.total === 0 ? 0 : full.counts.passed / full.counts.total,
    });
  }
  all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return opts.limit ? all.slice(0, opts.limit) : all;
}

/**
 * Prune older runs, keeping the most recent `keepLast` records per suite.
 * Suites are processed independently — an unscoped call (no `suiteName`)
 * prunes each distinct suite to keepLast, not keepLast combined across all
 * suites. Runs referenced by either the `latest-<suite>.json` or
 * `previous-<suite>.json` pointer for a suite are always protected from
 * deletion, so a prune call can never leave a pointer dangling on a missing
 * run (which would otherwise cause `cql_test_diff('previous')` to throw a
 * raw Error instead of returning the structured `no_previous_run` result).
 *
 * After pruning, a safety-net pass removes any pointer file (latest-* OR
 * previous-*) that is malformed JSON or whose referenced run is missing —
 * symmetric across both pointer kinds, so external state can't defeat the
 * no-previous-run contract.
 *
 * Returns the total number of run files deleted across all suites.
 */
export function pruneOldRuns(
  rootDir: string,
  keepLast: number,
  suiteName?: string,
): number {
  if (keepLast < 0) {
    throw new Error('keepLast must be >= 0');
  }
  const allRuns = listRuns(rootDir, {});

  // When a suiteName is given, scope strictly to that suite only — other
  // suites' runs are untouched. When omitted, prune every distinct suite
  // independently (each suite keeps its own `keepLast`).
  const suites = suiteName
    ? [suiteName]
    : Array.from(new Set(allRuns.map((r) => r.suiteName)));

  let deleted = 0;
  for (const suite of suites) {
    // Pointer-protected hashes for this suite (full 64-char, compared
    // directly against RunSummary.hash which is also full-length).
    const protectedHashes = new Set<string>();
    const latestPtr = readLatestPointer(rootDir, suite);
    if (latestPtr) {
      protectedHashes.add(latestPtr.hash);
    }
    const previousPtr = readPreviousPointer(rootDir, suite);
    if (previousPtr) {
      protectedHashes.add(previousPtr.hash);
    }

    const suiteRuns = allRuns.filter((r) => r.suiteName === suite);
    const toDelete = suiteRuns.slice(keepLast).filter((r) => !protectedHashes.has(r.hash));

    for (const summary of toDelete) {
      const file = runRecordPath(rootDir, summary.timestamp, summary.hash);
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        deleted++;
      }
    }
  }

  // Safety-net: sweep both pointer kinds. Removes a pointer if its JSON is
  // malformed, or if the run it points at can no longer be loaded (e.g. the
  // pointer file was hand-edited or survived from before a refactor). An
  // ambiguous pointer (loadRun cannot uniquely disambiguate) is left alone —
  // the pointer itself is valid, only the target set is non-unique. Transient
  // fs errors are propagated, never silently swallowed.
  const dir = runStoreDir(rootDir);
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (!(file.startsWith('latest-') || file.startsWith('previous-')) || !file.endsWith('.json')) {
        continue;
      }
      const fullPath = path.join(dir, file);
      try {
        const raw = fs.readFileSync(fullPath, 'utf-8');
        const ptr = JSON.parse(raw) as PointerRecord;
        if (typeof ptr.hash !== 'string') {
          fs.unlinkSync(fullPath);
          continue;
        }
        try {
          if (loadRun(rootDir, ptr.hash) === null) {
            fs.unlinkSync(fullPath);
          }
        } catch (err) {
          if (err instanceof AmbiguousRunRefError) {
            // Valid pointer, ambiguous target set — leave the pointer intact.
            continue;
          }
          throw err;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        if (err instanceof SyntaxError) {
          fs.unlinkSync(fullPath); // malformed JSON → delete
          continue;
        }
        throw err;
      }
    }
  }

  return deleted;
}
