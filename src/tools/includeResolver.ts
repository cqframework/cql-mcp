import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectRootOf } from '../lsp/documentSync.js';

export interface ResolveIncludeOptions {
  primaryFile: string;
  libraryName: string;
  version?: string;
  workspaceFolders?: string[];
  exists?: (p: string) => boolean;
}

/**
 * Resolves a referenced CQL library name to a concrete .cql file on disk using
 * a strict 3-tier priority search:
 *
 * Tier 1: Same directory as the referencing CQL file
 * Tier 2: Project layout relative to project root:
 *   - 2a: Direct under `<projectRoot>/input/cql/<Name>.cql` (standard IG publisher layout)
 *   - 2b: Base name under `<projectRoot>/input/cql/<basename>.cql` (for namespaced references like "fhir/FHIRHelpers")
 *   - 2c: Alternative directory `<projectRoot>/cql/<Name>.cql` (common non-IG repository layout)
 *   - 2d: Flat project root `<projectRoot>/<Name>.cql`
 * Tier 3: Registered workspace folders:
 *   - Direct in folder `<folder>/<Name>.cql`
 *   - Sibling IG layout `<folder>/input/cql/<Name>.cql`
 *   - Sibling `<folder>/cql/<Name>.cql`
 *
 * Returns the absolute path to the .cql file, or null if not found (e.g. built-in model library).
 */
export function resolveIncludePath(opts: ResolveIncludeOptions): string | null {
  const exists = opts.exists ?? fs.existsSync;
  const primaryDir = path.dirname(opts.primaryFile);
  const libName = opts.libraryName;
  const cqlFileName = `${libName}.cql`;

  // Tier 1: Same directory as primary file
  const sameDirCandidate = path.join(primaryDir, cqlFileName);
  if (exists(sameDirCandidate)) {
    return sameDirCandidate;
  }

  // Tier 2: IG layout relative to project root
  const root = projectRootOf(opts.primaryFile);
  const igCqlDir = path.join(root, 'input', 'cql');

  // 2a. Direct under input/cql/
  const igDirectCandidate = path.join(igCqlDir, cqlFileName);
  if (exists(igDirectCandidate)) {
    return igDirectCandidate;
  }

  // 2b. In case libraryName includes slashes (e.g. "fhir/FHIRHelpers")
  const basename = libName.split(/[\\/]/).pop() ?? libName;
  const igBasenameCandidate = path.join(igCqlDir, `${basename}.cql`);
  if (exists(igBasenameCandidate)) {
    return igBasenameCandidate;
  }

  // 2c. Direct under project root or <root>/cql/
  const rootCqlCandidate = path.join(root, 'cql', cqlFileName);
  if (exists(rootCqlCandidate)) {
    return rootCqlCandidate;
  }

  const directRootCandidate = path.join(root, cqlFileName);
  if (exists(directRootCandidate)) {
    return directRootCandidate;
  }

  // Tier 3: Search within specified workspace folders
  const folders = opts.workspaceFolders ?? [];
  for (const folder of folders) {
    const directFolder = path.join(folder, cqlFileName);
    if (exists(directFolder)) {
      return directFolder;
    }
    const folderInputCql = path.join(folder, 'input', 'cql', cqlFileName);
    if (exists(folderInputCql)) {
      return folderInputCql;
    }
    const folderCql = path.join(folder, 'cql', cqlFileName);
    if (exists(folderCql)) {
      return folderCql;
    }
  }

  return null;
}
