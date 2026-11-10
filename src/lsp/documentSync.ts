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
 * Path forms handled (each has unit tests):
 *
 * | Form                     | Example                         | Project root of a file in input/cql |
 * | ------------------------ | ------------------------------- | ----------------------------------- |
 * | macOS / Linux            | /a/proj/input/cql/X.cql         | /a/proj                             |
 * | Windows backslash        | C:\a\proj\input\cql\X.cql       | C:\a\proj                           |
 * | Windows forward slash    | C:/a/proj/input/cql/X.cql       | C:/a/proj                           |
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

const WINDOWS_FORM = /^[A-Za-z]:[\\/]|^\\\\|\\/;

/**
 * A comparison key for a path: forward slashes, no trailing slash, drive letter lower-cased.
 *
 * On a Windows host every input is resolved with win32 rules (so a relative or POSIX-form path
 * lands on the current drive); elsewhere a Windows-form input is kept as given and anything else
 * is resolved with POSIX rules. Backslashes are converted afterwards in every case, so the key of
 * a path and the key of the same path coming back from a `file://` URI always agree.
 * `platform` and `cwd` are injectable so both host kinds can be tested from any host.
 */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform, cwd: string = process.cwd()): string {
  let k: string;
  if (platform === 'win32') {
    k = path.win32.resolve(cwd, p);
  } else if (WINDOWS_FORM.test(p)) {
    k = p;
  } else {
    k = path.posix.resolve(cwd, p);
  }
  k = k.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:/.test(k)) {
    k = k[0]!.toLowerCase() + k.slice(1);
  }
  return k;
}

/** True when `file` is `folder` or lies inside it. */
export function isUnder(file: string, folder: string): boolean {
  const f = pathKey(file);
  const d = pathKey(folder);
  return f === d || f.startsWith(`${d}/`);
}

/**
 * The folder to register for a CQL file: the directory above `input/cql` when the file sits in an
 * IG-style `…/input/cql/…` layout (so sibling `input/` content such as modelinfo resolves), else
 * the file's own directory. The result keeps the input's separator style.
 */
export function projectRootOf(cqlFile: string): string {
  const sep = separatorOf(cqlFile);
  const parts = cqlFile.split(/[\\/]/);
  const i = inputCqlIndex(parts);
  if (i >= 0) {
    return parts.slice(0, i - 1).join(sep) || sep;
  }
  const dir = parts.slice(0, -1).join(sep);
  return dir || sep;
}

/**
 * The IG root to send as `rootDir` for a CQL file, or null.
 *
 * Supports the IG Publisher default layout (`path-binary` = `input/cql`), the only layout the
 * VS Code CQL extension supports, so the file must sit in `…/input/cql/…`; `path-binary` is not
 * parsed. `ig.ini` is the publisher's root marker, and this mirrors the server's own lookup
 * (IgContextManager.findIgContext), which looks for it at the project root and then in each
 * ancestor. Without `rootDir` the server loads no IG packages, so modelinfo such as USQualityCore
 * and IG namespaces fail to resolve. The result keeps the input's separator style.
 */
export function igRootOf(cqlFile: string, exists: (p: string) => boolean = fs.existsSync): string | null {
  const sep = separatorOf(cqlFile);
  const parts = cqlFile.split(/[\\/]/);
  const i = inputCqlIndex(parts);
  if (i < 0) {
    return null;
  }
  for (let k = i - 1; k >= 1; k--) {
    if (exists(`${parts.slice(0, k).join(sep)}${sep}ig.ini`)) {
      return projectRootOf(cqlFile);
    }
  }
  return null;
}

function separatorOf(p: string): string {
  return WINDOWS_FORM.test(p) && p.includes('\\') ? '\\' : '/';
}

/** Index of `cql` in the innermost `input/cql` pair of a split path, or -1 when there is none. */
function inputCqlIndex(parts: string[]): number {
  for (let i = parts.length - 2; i >= 1; i--) {
    if (parts[i] === 'cql' && parts[i - 1] === 'input') {
      return i;
    }
  }
  return -1;
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
      added: [{ uri: pathToUri(root), name: path.basename(root.replace(/[\\/]+$/, '')) || 'probe' }],
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
