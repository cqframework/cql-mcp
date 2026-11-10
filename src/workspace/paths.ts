import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DRIVE_LETTER_ABS = /^[A-Za-z]:[\\/]/;
const UNC_ABS = /^\\\\/;

function isWindowsForm(p: string): boolean {
  return DRIVE_LETTER_ABS.test(p) || UNC_ABS.test(p) || p.includes('\\');
}

export function pathToUri(p: string): string {
  if (process.platform !== 'win32' && isWindowsForm(p)) {
    const normalized = p.replace(/\\/g, '/');
    const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`;
    return pathToFileURL(absolute).toString();
  }
  return pathToFileURL(path.resolve(p)).toString();
}

export function uriToPath(uri: string): string {
  if (process.platform === 'win32') {
    return fileURLToPath(uri);
  }
  const pathname = decodeURIComponent(new URL(uri).pathname);
  if (/^\/[A-Za-z]:\//.test(pathname)) {
    return pathname.slice(1).replace(/\//g, '\\');
  }
  return fileURLToPath(uri);
}

export function libraryNameOf(cqlFile: string): string {
  const base = cqlFile.split(/[\\/]/).filter(Boolean).pop() ?? cqlFile;
  return base.endsWith('.cql') ? base.slice(0, -'.cql'.length) : base;
}

export function cacheJarDir(): string {
  return process.env.CQL_MCP_JAR_DIR ?? path.join(os.homedir(), '.cql-mcp', 'jars');
}

export function runStoreDir(rootDir: string): string {
  if (process.platform !== 'win32' && isWindowsForm(rootDir)) {
    return path.win32.join(rootDir, '.cql-debug', 'test-runs');
  }
  return path.join(rootDir, '.cql-debug', 'test-runs');
}

/**
 * Sanitize a suite name for use as a filename component. Replaces any character
 * outside [A-Za-z0-9._-] with '_' and caps length at 64 chars. Inputs that
 * contain no safe characters (empty, all whitespace, all unsafe punctuation)
 * collapse to 'default'.
 */
export function sanitizeSuiteNameForFs(suiteName: string): string {
  const cleaned = suiteName.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  // If the result has no safe characters left (i.e. it's all underscores), fall back.
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : 'default';
}

/**
 * Convert an ISO 8601 extended-format timestamp (e.g.
 * `2026-09-10T09:51:26.906Z`) into a filename-safe form by stripping
 * characters that are illegal on Windows/NTFS filesystems (notably `:` and
 * `.`). Produces ISO 8601 basic format (e.g. `20260910T095126906Z`), which
 * remains lexicographically sortable and stable across all three target
 * platforms (macOS/Linux forward slash, Windows backslash, Windows forward
 * slash). Per CLAUDE.md cross-platform path policy.
 */
export function fsSafeTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, '');
}

/**
 * Path of a single run record file. Filename = `<fs-safe-timestamp>-<hash8>.json`.
 * Plain accumulation: identical inputs at different timestamps produce different
 * files. No automatic overwrite. The timestamp is sanitized via fsSafeTimestamp
 * so the path is valid on Windows/NTFS.
 */
export function runRecordPath(rootDir: string, timestamp: string, hash: string): string {
  const safe = fsSafeTimestamp(timestamp);
  return path.join(runStoreDir(rootDir), `${safe}-${hash.slice(0, 8)}.json`);
}

/** Pointer file for the latest run of a given suite. */
export function latestPointerPath(rootDir: string, suiteName: string): string {
  return path.join(runStoreDir(rootDir), `latest-${sanitizeSuiteNameForFs(suiteName)}.json`);
}

/** Pointer file for the previous run (one run behind latest) of a given suite. */
export function previousPointerPath(rootDir: string, suiteName: string): string {
  return path.join(runStoreDir(rootDir), `previous-${sanitizeSuiteNameForFs(suiteName)}.json`);
}