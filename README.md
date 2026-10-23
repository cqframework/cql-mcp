# mcp-cql-debug

Standalone MCP server for HL7 CQL: execution, ELM inspection, DAP step-through debugging, and headless test runs against the cql-language-server JVM.

## Status

Phase 3 (test pipeline: 4 MCP tools + persisted run history + diff) shipped. 203 unit + 7 integration tests green. Smoke test confirms 16 tools registered and end-to-end persistence works.

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
| `npm test` | Both unit + integration |
| `npm run smoke` | End-to-end MCP stdio smoke (requires `CQL_LS_JAR_PATH`) |

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
| `CQL_LS_JAR_PATH` | (download from Maven Central) | Path to a pre-built `cql-ls-server-*.jar`. Bypasses download. |
| `CQL_LS_VERSION` | `4.10.0` | Maven version to download if no local jar. |
| `CQL_LS_MAVEN_REPO` | Maven Central | Maven base URL for jar download. |
| `CQL_DEBUG_MCP_JAR_DIR` | `~/.cql-debug-mcp/jars` | Where downloaded jars are cached. |
| `CQL_DEBUG_MCP_WORKSPACE` | `process.cwd()` | Workspace root under which `.cql-debug/test-runs/` is stored. |
| `CQL_DEBUG_MCP_LOG_FILE` | (stderr only) | Path to a structured log file (stderr stays clean). |
| `CQL_DEBUG_MCP_LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. |

Java is discovered via `JAVA_HOME` then `PATH`; needs JDK >= 17.

## Tools (16 total)

### Lifecycle and inspection

| Tool | Purpose |
|---|---|
| `cql_get_status` | JVM/LS readiness, jar path, java version, workspace root, LS version string |
| `cql_execute` | Execute a CQL library against the LS; per-expression results plus diagnostics |
| `cql_view_elm` | Return ELM as `xml`, `json`, or `ast` |

### DAP step-through debugging

| Tool | Purpose |
|---|---|
| `cql_debug_start` | Chain LSP `startDebugSession` to TCP connect to DAP `initialize/launch/configurationDone` in one call |
| `cql_debug_set_breakpoints` | Set breakpoints (1-indexed line numbers) |
| `cql_debug_continue` | Resume; blocks until stop, terminate, or timeout |
| `cql_debug_next` | Step over |
| `cql_debug_step_in` | Step into |
| `cql_debug_step_out` | Step out |
| `cql_debug_get_variables` | Scopes (by `frameId`) or a variable subtree (by `variablesReference`) |
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
  <fs-safe-ISO-timestamp>-<hash8>.json    # RunRecord (one per saveRun)
  latest-<sanitized-suite>.json            # Pointer: { hash }
  previous-<sanitized-suite>.json          # Pointer: { hash }
```

Filenames use `fsSafeTimestamp` (strips `:` and `.`) so the same paths work on macOS, Linux, and Windows/NTFS. Suite names are sanitized via `sanitizeSuiteNameForFs` (preserves `[A-Za-z0-9._-]`, replaces others with `_`, caps length at 64).

## Architecture notes

- **MCP transport:** stdio NDJSON, one JSON-RPC message per line. MCP SDK 1.30.0 does not use Content-Length framing.
- **Shutdown:** the server stops its LS JVM and exits when the client closes stdin (the SDK's stdio transport does not report this itself), and on SIGINT/SIGTERM. Shutdown is bounded: 3 s for the LS to answer `shutdown`, then SIGTERM/SIGKILL, and 15 s overall.
- **LSP/DAP pipes:** JVM stdout is pure LSP framing on its own pipe (read by `vscode-jsonrpc`). DAP uses Content-Length framing on a TCP socket per debug session.
- **Asymmetry:** `cql_execute` `libraryUri` is the parent dir of the .cql file; DAP `launch` `libraryUri` is the .cql file itself. `cql_debug_start` computes both internally — callers pass the .cql file once.
- **Out of scope:** This directory is intentionally outside any git checkout (per the original plan). It is not part of the `vscode-cql` or `cql-language-server` repos.

## Prompting agents

Once the MCP is wired into an agent (opencode, Claude Desktop, or any MCP-aware client), the agent sees the 16 `cql_*` tools directly. The prompts below are minimal-context — they point at file paths and let the agent investigate. Each template is a copy-paste block with placeholders you fill in for your measure.

### Tool-selection cheatsheet

| Scenario | Preferred tools |
|---|---|
| New-measure authoring (does my CQL match published expected results?) | `cql_test_run_suite` + per-define diff against `TestCaseResult-*.json` |
| Regression (why did this patient flip?) | `cql_test_run_file` then `cql_debug_start` + `cql_debug_set_breakpoints` + `cql_debug_continue` + `cql_debug_next` / `cql_debug_step_in` + `cql_debug_get_variables` + `cql_debug_evaluate` |
| Patient-bundle authoring (why doesn't this bundle trigger the population?) | `cql_test_run_file` then `cql_debug_evaluate` against the CQL retrieve expressions to compare engine output vs. bundle contents |
| Diff between two CQL versions | `cql_test_list_runs` + `cql_test_diff` with `runA="previous"` and `runB="latest"` |
| Compile inspection (does the LS interpret my CQL the way I read it?) | `cql_view_elm` with `elmType="ast"` or `elmType="json"` |

Always end a DAP session with `cql_debug_stop`. Always call `cql_get_status` first if the agent hasn't used the MCP in a while — it confirms the JVM and LS are up.

### Scenario 1 — new-measure authoring

```text
Run the CQL at <CQL_FILE> against every patient bundle under <TESTS_DIR>/measure/<SUITE_NAME>/
using the mcp-cql-debug tools. Compare each run's per-define results against
the matching TestCaseResult-*.json in <TESTS_DIR>/results/<SUITE_NAME>/.
Report every patient where any define disagrees with the expected value,
quoting actual vs. expected. Group mismatches by which define disagrees so
I can see if there's a systematic issue.
```

The agent will typically call `cql_test_run_suite` once (it walks Layout A: `<suiteRoot>/<suiteName>/<patient-uuid>/` automatically), then iterate the returned cases and diff against the JSON.

### Scenario 2 — regression (a specific patient flipped)

```text
Patient <PATIENT_UUID> is expected to be in <POPULATION> (true) but my latest
run shows false. The bundle is at <TESTS_DIR>/measure/<SUITE_NAME>/<PATIENT_UUID>/
and the expected results at <TESTS_DIR>/results/<SUITE_NAME>/TestCaseResult-<PATIENT_UUID>.json.
The CQL is <CQL_FILE>.

Use mcp-cql-debug to figure out which sub-clause of <POPULATION> fails first.
Use cql_debug_start, cql_debug_set_breakpoints, cql_debug_continue,
cql_debug_next / cql_debug_step_in / cql_debug_step_out, cql_debug_get_variables,
and cql_debug_evaluate to trace. End with cql_debug_stop.

Tell me which sub-clause fails first and the value of every relevant variable
at that point, with file:line references.
```

### Scenario 3 — patient-bundle authoring (the bundle doesn't trigger)

```text
I built a patient bundle under <TESTS_DIR>/measure/<SUITE_NAME>/<PATIENT_UUID>/
that should put this patient in <POPULATION> but the run shows false. The CQL
is <CQL_FILE>.

Use mcp-cql-debug to:
  1. Run the CQL against the patient and get the actual per-define values.
  2. For each define in the <POPULATION> path, call cql_debug_evaluate with
     the expression text from the CQL source and report what the engine returns.
  3. Compare those engine values against the FHIR resources in the bundle and
     identify the first place the bundle diverges from what the CQL expects.

End with cql_debug_stop. Tell me which FHIR resource / field / value is wrong
or missing.
```

### Scenario 4 — diff between two CQL versions

```text
I just edited <CQL_FILE>. There should be two persisted runs under suite
<SUITE_NAME> — use mcp-cql-debug's cql_test_list_runs to find them and then
cql_test_diff with runA="previous" and runB="latest".

For every entry in the diff's "changed" array, tell me in one sentence what
the change means. Pay special attention to entries with kind="expression-added"
or kind="expression-removed" — those are likely renames in the CQL source.
```

### Scenario 5 — compile inspection

```text
Show me the ELM for <CQL_FILE> using mcp-cql-debug's cql_view_elm with
elmType="ast". I want to verify that <RETRIEVE_EXPRESSION> compiles to a
ValueSetRef against <EXPECTED_VALUESET_URL> and that <FLUENT_FUNCTION>
is inlined correctly.
```

### One-line patterns for quick interactive use

```text
Use cql_test_run_suite on <CQL_FILE> with suiteRoot=<TESTS_DIR>/measure and
suiteName=<SUITE_NAME>. Then cql_test_diff runA="previous" runB="latest"
suiteName="<SUITE_NAME>". Summarize what changed.
```

```text
Use cql_debug_start on <CQL_FILE> with testCaseDir=<TESTS_DIR>/measure/<SUITE_NAME>/<PATIENT_UUID>.
Set a breakpoint at the line where <DEFINE_NAME> is defined. Continue, then
walk through with cql_debug_next and report what <EXPRESSION> returns at that
point. End with cql_debug_stop.
```

### What a competent agent will do (without explicit guidance)

1. First call `cql_get_status` to confirm the MCP server and JVM are up.
2. Read the CQL file to understand which defines exist.
3. Depending on whether you mentioned `TestCaseResult-*.json`:
   - If yes: `cql_test_run_file` once per patient plus diff per case.
   - If no: `cql_test_run_suite` for Layout A discovery.
4. On a mismatch: `cql_debug_start` + `cql_debug_set_breakpoints` at the suspicious define + `cql_debug_continue` + `cql_debug_next` + `cql_debug_get_variables` + `cql_debug_evaluate`.
5. End with `cql_debug_stop`. Prompt explicitly if the agent forgets.

### Tips for getting good results

- Prefer `cql_test_run_suite` / `cql_test_run_file` over `cql_execute` when bundles exist — you get persisted runs and diffs for free.
- Always tell the agent to call `cql_debug_stop` at the end. DAP sessions leak file descriptors otherwise.
- For CQL with parameters, pass `Measurement Period` explicitly in the prompt. The MCP defaults to whatever the CQL declares; if you are debugging against a non-default period, say so.
- For multi-step investigations, ask for a final summary in the same turn. Otherwise the agent can loop on tool calls without converging.
- If the agent has access to `mcp-cql-debug` plus other read-only tools (Read, Grep, Glob), it will often read the CQL source first to find the line numbers for breakpoints. Encourage this by pointing it at the file path.

### Gotchas

- **Tool names differ by client.** opencode exposes tools as `cql_*`. Claude Desktop prefixes with `mcp__mcp-cql-debug__cql_*`. Same prompts work for both; just be aware if you see tool names in logs.
- **`cql_test_run_suite` requires Layout A.** The discovery walks `<suiteRoot>/<suiteName>/<patient-uuid>/`. If your measure stores bundles elsewhere, fall back to looping `cql_test_run_file` over each patient ID.
- **Workspace root.** `CQL_DEBUG_MCP_WORKSPACE` defaults to `process.cwd()` of the MCP server, not your project. Set it explicitly in the MCP config so `.cql-debug/test-runs/` lands where you expect.
- **DAP `libraryVersion` is automatic.** `cql_debug_start` extracts the version from the CQL header. Don't pass it explicitly.
- **Breakpoints go on expression lines.** The LS only stops on expression lines, never on a `define "X":` line. `cql_debug_set_breakpoints` may still answer `verified: true` for a `define` line; the LS marks it unverified later. When a resume terminates without stopping although breakpoints were set, the result carries a `note`, the `unverifiedBreakpoints`, and `errors` from re-running the library with the launch settings.

### Worked example for CMS645

If you point an agent at the real CMS645 measure in `<IG_ROOT>`:

```text
Run the CQL at <IG_ROOT>/input/cql/CMS645FHIRBoneDensityPCADTherapy.cql
against every patient bundle under
<IG_ROOT>/input/tests/measure/CMS645FHIRBoneDensityPCADTherapy/
using the mcp-cql-debug tools. Compare each run's per-define results against
the matching TestCaseResult-*.json in
<IG_ROOT>/input/tests/results/CMS645FHIRBoneDensityPCADTherapy/.
Report every patient where any define disagrees with the expected value,
quoting actual vs. expected. Group mismatches by which define disagrees.
```

## Related plans

- Kotlin migration plus Spring Boot removal — applies to `cql-language-server`, not this dir; write-up lives in the workspace-root `CLAUDE.md` under "Historical: Kotlin Migration + Spring Boot Removal"
- Hybrid ANTLR hover architecture — applies to `cql-language-server`, not this dir
