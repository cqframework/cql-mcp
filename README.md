# cql-mcp

Standalone MCP server for HL7 CQL: execution, ELM inspection, DAP step-through debugging, and headless test runs against the [CQL Language Server](https://github.com/cqframework/cql-language-server) JVM.

## Status

All 19 tools are implemented: static inference and semantic analysis, lifecycle and inspection, DAP step-through debugging, and the test pipeline (persisted run history and diff). Run `npm test` for the current unit and integration results.

## Install and configure

Requires Node.js 22+ and a JDK 17+ (found through `JAVA_HOME`, then `PATH`). The
cql-language-server jar is resolved on first use: if vscode-cql is installed with the same
language server version, its jar is copied, otherwise it's downloaded from Maven. See
[Restricted networks](#restricted-networks).

cql-mcp is a local stdio server: the client starts it as a command on the same machine. The
**workspace** is your CQL project root. It's the server's working directory unless
`CQL_MCP_WORKSPACE` is set.

### The launch command

The npm package isn't published yet. Until it is, each
[GitHub release](https://github.com/cqframework/cql-mcp/releases) has the package tarball
attached, and `npx` runs it from its URL:

```sh
npx -y --package=<tarball-url> cql-mcp
```

where `<tarball-url>` is
`https://github.com/cqframework/cql-mcp/releases/download/v<version>/cqframework-cql-mcp-<version>.tgz`,
for example with `<version>` set to `0.1.0-rc.1`. The `--package=… cql-mcp` form is required:
`npx` doesn't run a tarball URL given on its own. To upgrade, change `<version>` to a newer release.

Once the npm package is published, the launch command becomes `npx -y @cqframework/cql-mcp`.

The first start downloads the package, which can take longer than some clients wait for a
server to start. If a client reports a startup timeout, start it again, or raise its timeout.

### Claude Code (terminal, IDE extensions and desktop app)

Run this from your CQL project directory:

```sh
claude mcp add cql-mcp -- npx -y --package=<tarball-url> cql-mcp
```

This uses the default `local` scope: the server is available only in that project. To make it
available in every project, add `--scope user` before `cql-mcp`. The workspace is the directory
you start Claude Code from. The `claude` CLI, the Claude Code VS Code and JetBrains extensions,
and the Claude Code desktop app all share this configuration.

### Claude Desktop (chat app)

The Claude chat app for macOS and Windows has no project directory, so set the workspace in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cql-mcp": {
      "command": "npx",
      "args": ["-y", "--package=<tarball-url>", "cql-mcp"],
      "env": { "CQL_MCP_WORKSPACE": "/path/to/your/cql/project" }
    }
  }
}
```

### VS Code (GitHub Copilot)

Add the server to the Copilot user configuration, `~/.copilot/mcp-config.json` (or
`$COPILOT_HOME/mcp-config.json`), or use the **MCP: Add Server** command:

```json
{
  "mcpServers": {
    "cql-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "--package=<tarball-url>", "cql-mcp"],
      "env": { "CQL_MCP_WORKSPACE": "/path/to/your/cql/project" }
    }
  }
}
```

This is a user-level configuration, so `CQL_MCP_WORKSPACE` points it at one project. The older
`.vscode/mcp.json` format (top-level key `servers`) still works and defaults the working
directory to the workspace folder, but VS Code has deprecated it. vscode-cql isn't required.
If it's installed with the same language server version, cql-mcp reuses its jar.

### OpenCode

Run this from your CQL project directory:

```sh
opencode mcp add cql-mcp -- npx -y --package=<tarball-url> cql-mcp
```

This writes `opencode.json` in the project. To add it by hand, use the v2 format, where
servers sit under `mcp.servers`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "cql-mcp": {
        "type": "local",
        "command": ["npx", "-y", "--package=<tarball-url>", "cql-mcp"]
      }
    }
  }
}
```

OpenCode starts local servers in the workspace by default. To point at a different project, add
`"environment": { "CQL_MCP_WORKSPACE": "/path/to/your/cql/project" }`.

### ChatGPT

The ChatGPT desktop app can run local servers: add one in its MCP settings, choose **STDIO**, and
enter the launch command, `npx -y --package=<tarball-url> cql-mcp`. Set `CQL_MCP_WORKSPACE` to your
CQL project. **ChatGPT on the web can't use cql-mcp.** It only supports remote MCP servers, and
cql-mcp runs locally next to your project files.

### Other MCP clients

Any client that can start a stdio MCP server works. Use `npx` as the command,
`["-y", "--package=<tarball-url>", "cql-mcp"]` as the arguments, and set `CQL_MCP_WORKSPACE`, or
the working directory, to your CQL project.

### From source

```sh
git clone https://github.com/cqframework/cql-mcp.git
cd cql-mcp
npm ci
npm run build
```

Then use `node /path/to/cql-mcp/dist/src/index.js` as the launch command in any of the
configurations above. Run `git pull && npm run build` to update.

## Quick start

```sh
npm install
npm run compile
npm run test:unit
npm run test:integration   # requires CQL_LS_JAR_PATH pointing at a real jar
```

## Build / test

| Command | Purpose |
|---|---|
| `npm run compile` | Emit `dist/src/**` from `tsconfig.json` |
| `npm run typecheck` | Type-check without emitting |
| `npm run test:unit` | Run mocha against `dist/test/unit/**` |
| `npm run test:integration` | Run mocha against `dist/test/integration/**` (requires Java + LS jar) |
| `npm run test:net` | Network tests against local fake repos and proxies (no JDK or real jar needed) |
| `npm test` | Unit + integration |
| `npm run smoke` | End-to-end MCP stdio smoke (requires `CQL_LS_JAR_PATH`) |
| `npm run test:e2e` | Restricted-network E2E: docker compose with an internal network, a private Reposilite mirror, squid and a TLS-intercepting proxy (needs Docker; scenario B downloads from the real Maven Central) |

## Smoke test

```sh
scripts/smoke.sh \
  "$PWD" \
  "$PWD" \
  /path/to/cql-ls-server.jar
```

Drives `initialize`, `tools/list`, a `cql_test_run_file` invocation, and a `cql_test_list_runs` call against `dist/src/index.js` (canonical entry per `package.json:bin`). Output is captured at `/tmp/mcp-smoke.stdout` and `/tmp/mcp-smoke.stderr`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `CQL_LS_JAR_PATH` | (see [Restricted networks](#restricted-networks)) | Path to a pre-built `cql-ls-server-*.jar`. Bypasses all other sources. |
| `CQL_LS_VERSION` | `5.0.0` | Maven version to download if no local jar. 5.0.0 is the first release with the LS DebugSession socket-close fix (`bf40a031`, 2026-09-17); `cql_debug_start` warns when the LS is older. |
| `CQL_LS_MAVEN_REPO` | (unset) | Maven base URL to download the jar from first. Maven Central is still tried last. Credentials in the URL (`https://user:pw@host/`) are sent as Basic auth to this repo only. |
| `CQL_LS_MAVEN_USERNAME` / `CQL_LS_MAVEN_PASSWORD` | (unset) | Basic-auth credentials for `CQL_LS_MAVEN_REPO` only. |
| `CQL_LS_MAVEN_SETTINGS` | `~/.m2/settings.xml` | Maven settings file to read mirrors and server credentials from. |
| `CQL_LS_DOWNLOAD_TIMEOUT_MS` | `60000` | A download attempt is aborted when no bytes arrive for this long (not a total-time limit). |
| `CQL_MCP_JAR_DIR` | `~/.cql-mcp/jars` | Where downloaded jars are cached. |
| `CQL_MCP_WORKSPACE` | `process.cwd()` | Workspace root under which `.cql-debug/test-runs/` is stored. |
| `CQL_MCP_LOG_FILE` | (stderr only) | Path to a structured log file (stderr stays clean). |
| `CQL_MCP_LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. |

The run store lives in `<workspace>/.cql-debug/test-runs/`.

Java is discovered via `JAVA_HOME` then `PATH`; needs JDK >= 17. Java and the language-server jar are resolved on first use, not at startup, so the server answers `initialize` immediately; call `cql_get_status` to watch a first-run download (`runtime.state`, `runtime.phase`, `runtime.download`).

## Restricted networks

The language-server jar comes from the first of these that has it:

1. `CQL_LS_JAR_PATH`, run in place.
2. The cql-mcp cache, `~/.cql-mcp/jars/cql-ls-server-<version>.jar` (or `CQL_MCP_JAR_DIR`), run in place.
3. The vscode-cql extension's jar for the **same version** (`~/.vscode*/extensions/cqframework.cql-*/dist/java-support/jars/`), copied into the cache because VS Code deletes old extension folders on update.
4. A download from `CQL_LS_MAVEN_REPO`, only when set.
5. A download from the mirror in your Maven `settings.xml` whose `<mirrorOf>` matches `central` (`central`, `*` or `external:*`, and not excluded by `!central`).
6. A download from Maven Central, always last.

`cql_get_status` reports which one was used as `jarSource` (`env`, `cache`, `vscode-extension` or `download`). If every source fails, the error lists every path and URL tried with the reason for each, and never includes credentials.

- **`settings.xml`.** Mirrors and `<servers>` credentials are read automatically from `~/.m2/settings.xml` and `$MAVEN_HOME/conf/settings.xml` (or `$M2_HOME`), with user settings overriding global ones by `<id>`. `${env.NAME}` and `${user.home}` placeholders are expanded; a value with an unset placeholder is skipped with a warning. Not supported: `<localRepository>` (the local Maven repository is never searched), `<proxies>` (use the variables below), and encrypted `{…}` passwords (skipped with a warning).
- **Proxy.** Downloads honour `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (upper or lower case). Proxy credentials in the URL (`http://user:pw@proxy:3128`) work. Only the download is proxied; the language server JVM is not configured.
- **Corporate TLS.** Set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` for a TLS-intercepting proxy or a private CA. Node reads it at startup, so set it in the MCP client's `env`.
- **Integrity.** The download is checked against its `.sha1` (a missing `.sha1` is accepted with a warning; any other `.sha1` failure fails that source) and against `Content-Length`.
- **Manual fallback.** Download `cql-ls-server-<version>.jar` yourself and copy it into `~/.cql-mcp/jars/`, or point `CQL_LS_JAR_PATH` at it.
- **Windows.** A running cql-mcp holds its jar open. Rebuilding or reinstalling a jar that a running instance uses directly (`CQL_LS_JAR_PATH`) fails until that instance exits.

## Tools (19 total)

### Errors, annotations and output size

- **Errors.** A tool failure comes back as a normal result with `isError: true` and a message written for the model (what failed and, where known, what to do). That covers invalid arguments (`Input validation error: … at <argument>`), a missing file, CQL or language-server errors, a missing JDK, and an unknown tool name. If the language server crashes, the message starts with a sentence ("The CQL language server crashed (exit code N) …") and ends with the crash details as JSON; the next call that needs the server starts a new one (at most 3 starts per cql-mcp session). JSON-RPC errors are reserved for protocol problems such as a malformed request.
- **Annotations.** Every tool declares MCP annotations so a client can auto-approve the safe ones. `cql_get_status`, `cql_get_signatures`, `cql_resolve_includes`, `cql_validate`, `cql_view_elm`, `cql_execute`, `cql_test_list_runs` and `cql_test_diff` are read-only and idempotent. The `cql_debug_*` tools (stateful session) and `cql_test_run_file` / `cql_test_run_suite` (write run records under `.cql-debug/test-runs/`) are not read-only. None is destructive or open-world.
- **Output size.** Results are compact JSON. `cql_view_elm`, `cql_execute` and `cql_debug_get_variables` take an optional `maxChars` (integer, at least 1000, default 50000). `maxChars` bounds the serialized JSON result. A larger result comes back with `truncated: true`, `totalChars` (its full serialized length) and `maxChars`: `cql_view_elm` cuts `content` to the longest prefix that keeps the whole serialized result within `maxChars` (escaped quotes count; `totalChars` is the full serialized length); `cql_execute` drops trailing expression results (listed by name in `omittedExpressions`, with `omittedCount`) and counts dropped log lines in `omittedLogLines`, keeping the diagnostics; `cql_debug_get_variables` drops trailing variables (listed in `omittedVariables`). Narrow the request or raise `maxChars` to see more.

### Static inference and semantic analysis

| Tool | Purpose |
|---|---|
| `cql_get_signatures` | Extract all expressions (`define`), functions, parameters, value sets, and code systems with their compiled ELM types |
| `cql_resolve_includes` | Resolve included libraries on disk (IG/workspace) and surface their exported public defines and function signatures |
| `cql_validate` | Validate syntax and typing for a file or in-memory content, returning compiler diagnostics without running tests |

### Lifecycle and inspection

| Tool | Purpose |
|---|---|
| `cql_get_status` | JVM/LS readiness, jar path, java version, workspace root, LS version string |
| `cql_execute` | Execute a CQL library against the LS; per-expression results plus diagnostics (bounded by `maxChars`) |
| `cql_view_elm` | Return ELM as `xml`, `json`, or `ast` (bounded by `maxChars`) |

### DAP step-through debugging

| Tool | Purpose |
|---|---|
| `cql_debug_start` | Chain LSP `startDebugSession` to TCP connect to DAP `initialize/launch/configurationDone` in one call |
| `cql_debug_set_breakpoints` | Set breakpoints (1-indexed line numbers) |
| `cql_debug_continue` | Resume; blocks until stop, terminate, or timeout |
| `cql_debug_next` | Step over |
| `cql_debug_step_in` | Step into |
| `cql_debug_step_out` | Step out |
| `cql_debug_get_variables` | Scopes (by `frameId`) or a variable subtree (by `variablesReference`); bounded by `maxChars` |
| `cql_debug_evaluate` | Evaluate a CQL expression in the current frame or watch context |
| `cql_debug_stop` | Disconnect and close TCP socket |

### Test pipeline (Phase 3)

| Tool | Purpose |
|---|---|
| `cql_test_run_file` | Run a single .cql against context values; persist and rotate pointers |
| `cql_test_run_suite` | Discover Layout A test cases, merge params from `config.jsonc`, run and persist |
| `cql_test_list_runs` | Newest-first listing; optional `suiteName` filter plus `limit` |
| `cql_test_diff` | Diff two persisted runs by hash or pointer (`latest` / `previous`) |

## Project layout (IG Publisher default)

CQL files are expected in the HL7 IG Publisher default layout, the only layout the VS Code CQL extension supports:

```text
<root>/
  ig.ini                                  # publisher root marker; may also sit in an ancestor of <root>
  input/cql/*.cql                         # path-binary = input/cql (the default)
  input/cql/cql-options.json              # default-layout CQL options
  input/vocabulary/valueset/              # default-layout value sets
  input/tests/<Library>/<case>/*.json     # CQF test-case convention (not a publisher parameter)
```

For a `.cql` file in `<root>/input/cql/` with an `ig.ini` at `<root>` or above, `cql_execute`, `cql_test_run_file`, `cql_test_run_suite` and `cql_debug_start` send:

| Field | Default | Why |
|---|---|---|
| `rootDir` | `<root>` | The LS finds `ig.ini` from here and loads the IG's packages. Without it, IG libraries fail to compile (for example `Could not load model information for model USQualityCore`). |
| `terminologyUri` | `<root>/input/vocabulary/valueset` (if it exists) | Default-layout value sets |
| `optionsPath` | `<root>/input/cql/cql-options.json` (if it exists) | Default-layout CQL options |

Explicit arguments override each default. Files outside an `input/cql` folder (for example a scratch probe in `<root>/temp/`) get no `rootDir`, as before. A probe folder that has its own `input/cql` inside an IG (for example `<root>/temp/probe/input/cql/X.cql`) gets the probe folder as `rootDir`, and the LS then finds the enclosing IG's `ig.ini`, so the probe runs in that IG's context. A non-default `path-binary` is not supported: pass `rootDir` explicitly.

`cql_test_run_suite` also sends each test-case folder as the data model, so every case is evaluated against its own FHIR resources. `cql_test_run_file` reads patient data only when `modelUri` is set.

Case status in a run record: `passed` means evaluated with no `Error` entries, `failed` means the LS returned `Error` entries (such as compile errors), `errored` means the LS crashed on that case, and `skipped` means not run after a crash. Status is not a comparison against expected results.

## On-disk layout

Run records and per-suite pointers are stored under `<workspaceRoot>/.cql-debug/test-runs/`:

```sh
.cql-debug/test-runs/
  <fs-safe-ISO-timestamp>-<hash8>.json     # RunRecord (one per saveRun)
  latest-<sanitized-suite>.json            # Pointer: { hash }
  previous-<sanitized-suite>.json          # Pointer: { hash }
```

Filenames use `fsSafeTimestamp` (strips `:` and `.`) so the same paths work on macOS, Linux, and Windows/NTFS. Suite names are sanitized via `sanitizeSuiteNameForFs` (preserves `[A-Za-z0-9._-]`, replaces others with `_`, caps length at 64).

## Architecture notes

- **MCP transport:** stdio NDJSON, one JSON-RPC message per line. MCP SDK 1.30.0 does not use Content-Length framing.
- **Shutdown:** the server stops its LS JVM and exits when the client closes stdin (the SDK's stdio transport does not report this itself), and on SIGINT/SIGTERM. Shutdown is bounded: 3 s for the LS to answer `shutdown`, then SIGTERM/SIGKILL, and 15 s overall.
- **LS stdout is the LSP channel.** The language server JVM's stdout carries the LSP frames, so anything it prints there before the first frame (for example logback status messages from a broken bundled `logback.xml`) corrupts the channel and `initialize` fails or hangs. Force a known-good config with `-Dlogback.configurationFile=<path>`; the integration tests do this through `CqlLsProcess`'s `logbackConfigFile` option.
- **LSP/DAP pipes:** JVM stdout is pure LSP framing on its own pipe (read by `vscode-jsonrpc`). DAP uses Content-Length framing on a TCP socket per debug session.
- **Asymmetry:** `cql_execute` `libraryUri` is the parent dir of the .cql file; DAP `launch` `libraryUri` is the .cql file itself. `cql_debug_start` computes both internally — callers pass the .cql file once.
- **Repository:** [cqframework/cql-mcp](https://github.com/cqframework/cql-mcp). It is a standalone project, separate from [cqframework/vscode-cql](https://github.com/cqframework/vscode-cql) and [cqframework/cql-language-server](https://github.com/cqframework/cql-language-server); it drives the language server jar but does not build it.

## Agent guidance

cql-mcp sends built-in instructions to every MCP client in its `initialize` result: what the server is for, which tool to choose, the order of the main workflows (validate, run, test and diff, debug) and the rules that prevent common mistakes. Nothing needs installing, and clients that support server instructions give them to the model automatically.

### Tool-selection cheatsheet

| Scenario | Preferred tools |
|---|---|
| Understand a library's public defines and types without reading the whole file | `cql_get_signatures` |
| Inspect included libraries without reading them in full | `cql_resolve_includes` |
| Check an edit before running it | `cql_validate` with in-memory `content` or a file path |
| New measure: do the results match the expected ones? | `cql_test_run_suite`, then compare each case's per-define values with the expected results (a `passed` status is not a comparison) |
| Regression: why did this patient flip? | `cql_test_run_file`, then `cql_debug_start` + `cql_debug_set_breakpoints` + `cql_debug_continue` + `cql_debug_next` / `cql_debug_step_in` + `cql_debug_get_variables` + `cql_debug_evaluate`, ending with `cql_debug_stop` |
| Patient bundle doesn't trigger a population | `cql_test_run_file`, then `cql_debug_start` and `cql_debug_evaluate` on the retrieve expressions, ending with `cql_debug_stop` |
| Diff between two CQL versions | `cql_test_list_runs` + `cql_test_diff` with `suiteName`, `runA="previous"` and `runB="latest"` |
| Compile inspection | `cql_view_elm` with `elmType="ast"` or `"json"` |

### The cql-mcp skill

The longer playbooks (the scenario walk-throughs, static inference versus a run, debugging rules and
gotchas) are in a Claude skill: [`skills/cql-mcp/SKILL.md`](skills/cql-mcp/SKILL.md). Claude loads
it only when a task matches its description. It isn't in the npm package, so install it separately:

- **Claude Code:** copy `skills/cql-mcp/` to `~/.claude/skills/` (all projects) or to a project's
  `.claude/skills/`.
- **Claude Desktop:** upload `cql-mcp-skill.zip`, attached to each
  [GitHub release](https://github.com/cqframework/cql-mcp/releases).

## Design decisions

Architecture decision records live in [`docs/adr/`](docs/adr/).

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
