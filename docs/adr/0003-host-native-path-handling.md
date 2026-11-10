---
title: "ADR-0003: Host-Native Path Handling"
status: "Accepted"
date: "2026-11-10"
tags: ["paths", "uris", "windows", "cross-platform", "testing"]
---

## 1. Context

cql-mcp turns file paths into `file://` URIs for the language server, turns URIs back into paths,
and compares paths (`pathKey`, `isUnder`), for example to match diagnostics to files. Since the
original import, it has also accepted **Windows-form paths while running on macOS or Linux**:
`C:\a\X.cql`, `C:/a/X.cql` and `\\server\share`.

- `src/workspace/paths.ts`: `isWindowsForm` (`DRIVE_LETTER_ABS`, `UNC_ABS`, "contains a
  backslash"), plus the special branches in `pathToUri`, `uriToPath`, `joinLike` and
  `runStoreDir`.
- `src/lsp/documentSync.ts`: `WINDOWS_FORM`, `separatorOf`, and the Windows-form branch in
  `pathKey`.

This code works out what OS a path belongs to by inspecting the string, then simulates that
OS's rules.

**No real deployment needs it.** cql-mcp runs over stdio, launched by its client, so the client
and the server share a host and a file system. Paths arrive in the host's own format. stdio can
cross environments through a bridge command such as `wsl.exe -- npx …`, `docker run -i …` or
`ssh host …`. In every such case the real problem is **mapping between file systems** (`C:\` ↔
`/mnt/c`, host folder ↔ container mount), not the format of the path string. The current code
doesn't solve that. It turns `C:\p\X.cql` into `file:///C:/p/X.cql` on Linux, and the JVM can't
open it. Windows-form input on a POSIX host only ever happens in our own tests.

**It has a cost.** Inspecting path strings is a second set of path rules alongside Node's own.
It's where the Windows-host `pathKey` bug lived: backslashes from `path.resolve` were never
normalized, so `cql_validate` with a relative path on Windows reported no diagnostics. It also
lets tests on macOS appear to cover Windows when they don't. Before Phase 1 there was no Windows
CI, and 13 unit tests had never run on Windows.

## 2. Decision

### 2.1 Product code follows the host's path rules only

- Build, resolve and normalize paths with `node:path` on the host (`path.join`, `path.resolve`,
  `path.normalize`, `path.sep`, `path.dirname`).
- Convert between paths and URIs with `node:url` (`pathToFileURL`, `fileURLToPath`).
- **Never** infer a path's OS from its contents: no drive-letter, UNC or backslash detection to
  choose rules. A backslash on macOS/Linux is an ordinary filename character, as POSIX defines it.
- Branch on the **host** only where behaviour genuinely differs, with the platform passed in as a
  parameter that defaults to `process.platform`, so it can be tested. The cases are:
  - executable names (`java.exe`)
  - case-insensitive comparison keys on Windows (`pathKey` lower-cases the drive letter and uses
    `/` as the key separator)
  - file-locking retries (`EBUSY`)

### 2.2 What must work on Windows hosts

On a Windows host, cql-mcp accepts both native forms, `C:\a\X.cql` and `C:/a/X.cql`, through
`path.win32` semantics. It also accepts relative paths and URIs with either drive-letter case
(`file:///C:/…`, `file:///c%3A/…`). `pathKey` treats all of these as the same file.

### 2.3 Cross-environment setups need explicit path mapping

Running the server in WSL, a container or a remote host while the client sends paths from its own
side isn't supported. If it's ever needed, it gets an explicit mapping feature, for example
`CQL_MCP_PATH_MAP="C:\=/mnt/c/"`, under its own ADR. It must never come back through string
inspection.

### 2.4 Testing

- Each CI runner tests its **own** native forms. macOS and Linux cover `/path/to/file`. Windows
  covers `C:\path\to\file` and `C:/path/to/file`. Together, the CI matrix (ubuntu, macos,
  windows) covers the three-format rule.
- Tests build their inputs with `path.join`, `path.resolve` and `os.tmpdir()` where they can.
  Hard-coded native paths are allowed only inside a per-platform block (`onWindows(…)` or
  `onPosix(…)`), and every such block has a counterpart for the other platform.
- Where the platform is a parameter, `path.win32`/`path.posix` may be used to test both
  branches from any host. That's a test seam, not product behaviour.

## 3. Alternatives Considered

* **Keep the cross-host handling.** **Rejected.** It serves no real deployment, and it doesn't
  solve the bridged cases it might seem to cover. It's a second set of path rules where bugs hide.
* **A normalizing library (`pathe`, `upath`, `slash`).** **Rejected for now.** Node's `path` and
  `url` already cover host-native behaviour, and a new dependency would be pinned and audited
  (ADR-0001 §2.8) only to replace one `replace()`.
* **`vscode-uri` for path ⇄ URI.** **Deferred.** It's already a dependency, and it matches VS Code's
  URI style. It also follows the host, though, and switching would change URI encoding (for
  example `c%3A`). Reconsider if the LS or a client turns out to be sensitive to URI style.
* **Path mapping for WSL or Docker now.** **Rejected.** Nobody has asked for it (§2.3).

## 4. Consequences

* **Positive:** There's one set of path rules, Node's, and less code, with every Windows-form
  regex and `separatorOf` gone.
* **Positive:** Windows behaviour is tested on Windows, where it's real, so CI results can be
  trusted.
* **Negative:** macOS developers no longer see Windows-form path tests run locally. Those failures
  show up only in CI. Tests that take an injected platform (`pathKey`) still run both branches
  locally.
* **Negative:** A backslash-containing path given to cql-mcp on macOS/Linux is treated as a POSIX
  filename, no longer as a Windows path. That's correct POSIX behaviour, but it's a change.

## 5. Agent Directives

* **MUST NOT** detect a path's OS from its contents (drive letters, UNC prefixes, backslashes)
  to choose path rules.
* **MUST** use `node:path` and `node:url` for host path handling, and take the platform as a
  parameter (default `process.platform`) wherever host-specific behaviour needs a test.
* **MUST** cover each changed path behaviour on its own platform: POSIX forms on macOS/Linux CI,
  and `C:\` and `C:/` forms on Windows CI. Every per-platform test block needs a counterpart for
  the other platform.
* **MUST NOT** add support for client/server file system mapping (WSL, containers, SSH) without a
  new ADR (§2.3).
