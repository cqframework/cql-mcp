import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToUri } from '../workspace/paths.js';

/**
 * Keeps the language server's view of a CQL file in step with the file on disk.
 *
 * Two language-server behaviours make this necessary:
 *
 * - The compiled-library cache (CqlCompilationManager) is invalidated on `didChange` and
 *   `didChangeWatchedFiles`, but not on `didOpen`. Re-sending `didOpen` for an edited file updates
 *   the stored text yet leaves the old compile in place, so `viewElm` returns stale ELM. After the
 *   first open, we therefore send `didChange` (full text, next version) whenever the text differs.
 * - FileContentService only reads files inside the workspace folders the server knows about. A
 *   file outside them ("Could not load source for library …") becomes reachable once its project
 *   folder is added with `workspace/didChangeWorkspaceFolders`.
 *
 * State is held per client, so a respawned language server (a new client) starts fresh.
 *
 * Paths follow the host's own rules (ADR-0003); each CI runner tests its native forms:
 *
 * | Host           | Example input                  | Project root of a file in input/cql |
 * | -------------- | ------------------------------ | ----------------------------------- |
 * | macOS / Linux  | /a/proj/input/cql/X.cql        | /a/proj                             |
 * | Windows        | C:\a\proj\input\cql\X.cql      | C:\a\proj                           |
 * | Windows        | C:/a/proj/input/cql/X.cql      | C:\a\proj (normalized)              |
 */

export interface NotificationSink {
  sendNotification(method: string, params?: unknown): void;
}

interface DocState {
  version: number;
  text: string;
}

interface SyncState {
  docs: Map<string, DocState>;
  /** Workspace folders the server knows about, as normalised comparison keys. */
  folders: Set<string>;
}

const states = new WeakMap<NotificationSink, SyncState>();

function stateFor(client: NotificationSink): SyncState {
  let s = states.get(client);
  if (!s) {
    s = { docs: new Map(), folders: new Set() };
    states.set(client, s);
  }
  return s;
}

/**
 * A comparison key for a path: the host's own resolution rules, then forward slashes, no trailing
 * slash and a lower-case drive letter on Windows, so `C:\\a\\X.cql`, `C:/a/X.cql`, a relative path
 * and `file:///c%3A/a/X.cql` (via uriToPath) all give the same key. The rules come from `platform`
 * only, never from the string (ADR-0003); `platform` and `cwd` are injectable so both branches can
 * be tested from any host.
 */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform, cwd: string = process.cwd()): string {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  let k = impl.resolve(cwd, p);
  if (platform === 'win32') {
    k = k.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(k)) {
      k = k[0]!.toLowerCase() + k.slice(1);
    }
  }
  // resolve() already removed trailing separators except on a root ('/', 'c:/', '//srv/share/').
  return k.length > 1 && !k.endsWith(':/') ? k.replace(/\/+$/, '') : k;
}

/** True when `file` is `folder` or lies inside it. */
export function isUnder(file: string, folder: string): boolean {
  const f = pathKey(file);
  const d = pathKey(folder);
  return f === d || f.startsWith(`${d}/`);
}

/**
 * The root of the innermost `…/input/cql/…` layout containing `cqlFile` (the directory above
 * `input`), or null when the file isn't in one. Walks parents with `path.dirname`, so roots and
 * separators follow the host.
 */
function inputCqlRoot(cqlFile: string): string | null {
  let dir = path.dirname(path.normalize(cqlFile));
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    if (path.basename(dir) === 'cql' && path.basename(parent) === 'input') {
      return path.dirname(parent);
    }
    dir = parent;
  }
}

/**
 * The folder to register for a CQL file: the directory above `input/cql` when the file sits in an
 * IG-style `…/input/cql/…` layout (so sibling `input/` content such as modelinfo resolves), else
 * the file's own directory. Separators follow the host (`path.normalize`).
 */
export function projectRootOf(cqlFile: string): string {
  return inputCqlRoot(cqlFile) ?? path.dirname(path.normalize(cqlFile));
}

/**
 * The IG root to send as `rootDir` for a CQL file, or null.
 *
 * Supports the IG Publisher default layout (`path-binary` = `input/cql`), the only layout the
 * VS Code CQL extension supports, so the file must sit in `…/input/cql/…`; `path-binary` is not
 * parsed. `ig.ini` is the publisher's root marker, and this mirrors the server's own lookup
 * (IgContextManager.findIgContext), which looks for it at the project root and then in each
 * ancestor. Without `rootDir` the server loads no IG packages, so modelinfo such as USQualityCore
 * and IG namespaces fail to resolve. Separators follow the host.
 */
export function igRootOf(cqlFile: string, exists: (p: string) => boolean = fs.existsSync): string | null {
  const root = inputCqlRoot(cqlFile);
  if (root === null) {
    return null;
  }
  for (let dir = root; ; ) {
    if (exists(path.join(dir, 'ig.ini'))) {
      return root;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** Record a folder the server already knows about (for example, the one passed to `initialize`). */
export function registerWorkspaceFolder(client: NotificationSink, folder: string): void {
  stateFor(client).folders.add(pathKey(folder));
}

/**
 * Make sure some known workspace folder contains `cqlFile`; if none does, add the file's project
 * root. Returns the folder added, or null when none was needed.
 */
export function ensureWorkspaceFolder(client: NotificationSink, cqlFile: string): string | null {
  const s = stateFor(client);
  for (const key of s.folders) {
    if (isUnder(cqlFile, key)) {
      return null;
    }
  }
  const root = projectRootOf(cqlFile);
  client.sendNotification('workspace/didChangeWorkspaceFolders', {
    event: {
      added: [{ uri: pathToUri(root), name: path.basename(root) || 'probe' }],
      removed: [],
    },
  });
  s.folders.add(pathKey(root));
  return root;
}

export type SyncOutcome = 'opened' | 'changed' | 'unchanged';

/**
 * Send the file's current text to the server: `didOpen` the first time, then `didChange` with the
 * next version whenever the text differs. Unchanged text sends nothing, which keeps the server's
 * compile cache warm.
 */
export function syncCqlDocument(client: NotificationSink, cqlFile: string, text?: string): SyncOutcome {
  const body = text ?? fs.readFileSync(cqlFile, 'utf8');
  const uri = pathToUri(cqlFile);
  const s = stateFor(client);
  const prev = s.docs.get(uri);
  if (!prev) {
    client.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId: 'cql', version: 1, text: body },
    });
    s.docs.set(uri, { version: 1, text: body });
    return 'opened';
  }
  if (prev.text === body) {
    return 'unchanged';
  }
  const version = prev.version + 1;
  client.sendNotification('textDocument/didChange', {
    textDocument: { uri, version },
    contentChanges: [{ text: body }],
  });
  s.docs.set(uri, { version, text: body });
  return 'changed';
}
