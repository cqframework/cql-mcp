---
name: cql-mcp
description: Use when running, validating, inspecting or debugging HL7 CQL (Clinical Quality Language) libraries through the cql-mcp tools (cql_validate, cql_execute, cql_view_elm, cql_test_run_suite, cql_test_diff, cql_debug_start and the rest) — checking edits, finding which define makes a patient's result wrong, running test-case bundles, diffing two runs, or stepping through a library with breakpoints.
---

# cql-mcp

Playbooks for the `cql_*` tools of the cql-mcp MCP server. The server's built-in instructions give
the short version; this skill has the order of steps, the arguments that matter and the traps. It
covers using the tools. For CQL language questions (syntax, semantics, FHIR and QI-Core patterns),
use the CQL skills instead.

## Basics

- **Workspace.** The workspace is the CQL project root: the server's working directory, or
  `CQL_MCP_WORKSPACE` when set. Persisted test runs live in `<workspace>/.cql-debug/test-runs/`.
  The test-run tools take an optional `workspaceRoot` that overrides it.
- **First call.** Java and the language-server jar are resolved on first use, and a first run can
  download the jar. Call `cql_get_status` and check `runtime.state` (`resolving` shows a `phase`
  and download progress) when the first call is slow or fails.
- **Errors.** A failed tool call is a normal result with `isError: true` and a message written to
  be acted on. If the language server crashed, the next call that needs it starts a new one (at
  most 3 per session).
- **Tool names by client.** Some clients show the tools as `cql_execute`; Claude Code shows
  `mcp__<server-key>__cql_execute`, where `<server-key>` is the name the server was registered
  under.
- **IG layout.** For a `.cql` file in `<root>/input/cql/` with an `ig.ini` at `<root>` or above,
  `cql_execute`, the test-run tools and `cql_debug_start` default `rootDir`, `terminologyUri` and
  `optionsPath` to the IG's default-layout paths. Explicit arguments override. For any other
  location, pass `rootDir` yourself. Without it an IG library fails to compile (for example
  "Could not load model information for model USQualityCore").

## Choosing a tool

| Goal | Tools |
|---|---|
| Know a library's public defines, functions and types without reading it | `cql_get_signatures` (`includePrivate` adds private ones) |
| Know what an included library offers | `cql_resolve_includes` (`alias` narrows it to one include) |
| Check an edit before running it | `cql_validate` with `content` for unsaved text |
| See how the compiler read the CQL | `cql_view_elm` with `elmType` set to `xml`, `json` or `ast` |
| Run a library, quickly | `cql_execute` (`contextValues`, `modelUri`, `parameters`) |
| Run test-case folders and keep the results | `cql_test_run_suite`, or `cql_test_run_file` for one file and a list of patients |
| Compare two runs | `cql_test_list_runs`, then `cql_test_diff` |
| Find out why a value is wrong | `cql_debug_start`, then the stepping tools, `cql_debug_get_variables` and `cql_debug_evaluate` |

## Static inference or a run

- **Large helper libraries.** `FHIRHelpers` and the measure-authoring common-function libraries are
  thousands of lines. Use `cql_resolve_includes` or `cql_get_signatures` to read their typed public
  interface instead of reading the files.
- **Symbols.** To find which functions or defines exist, and what types they return, prefer
  `cql_get_signatures` and `cql_resolve_includes` over grepping. They report the compiled types
  (`List<FHIR.Encounter>`, `Interval<DateTime>`), so you don't have to infer them.
- **Validate first.** `cql_validate` answers syntax and type errors without loading patient data
  or starting an evaluation. Pass `content` to check an edit before saving it. It waits for the
  compiler's diagnostics, bounded by `timeoutMs` (and `quiescenceMs`).
- **Run second.** Run only once validation is clean.

## Playbooks

### New measure: do the results match the expected ones?

1. `cql_validate` the library.
2. `cql_test_run_suite` with `cqlFile`, `suiteRoot` and `suiteName`. It runs every case under
   `<suiteRoot>/<suiteName>/<patient-uuid>/` (the `shared` folder is always skipped), evaluating
   each against its own folder's FHIR resources. `excludeTestCases` skips more; `configPath` points
   at a `config.jsonc` that supplies per-case parameters.
3. The result is a run record: counts, and per case a `patientId`, a `status` and the
   per-expression values.
4. **`status` is not a verdict.** `passed` means the run had no `Error` entries. `failed` means the
   language server returned `Error` entries (for example compile errors). `errored` means the
   server crashed on that case, and `skipped` means it wasn't run after a crash. Nothing is
   compared with expected results, so read the expected-result files yourself (look beside the
   test cases in the project) and compare each define, then group the mismatches by define to see
   whether the cause is shared.

If the test cases don't follow `<suiteRoot>/<suiteName>/<patient-uuid>/`, loop `cql_test_run_file`
over the patients instead, with `contextValues` and `modelUri` set to each case's folder.

### Regression: one patient's result is wrong

1. Run the patient with `cql_test_run_file` (`contextValues` and `modelUri` set to the patient's
   test-case folder) and note the wrong define.
2. Read the CQL to find the expression line inside that define.
3. `cql_debug_start` with `cqlFile`, `testCaseDir` (the patient's folder) and `breakpoints` (the
   expression lines). Add `parameters` when the library needs non-default values.
4. When a resume stops, the result has `topFrame`. Use its `id` as `frameId` for
   `cql_debug_get_variables`, and use `cql_debug_evaluate` to test sub-expressions in that frame.
5. Move with `cql_debug_next`, `cql_debug_step_in` and `cql_debug_step_out`, or
   `cql_debug_continue` to the next breakpoint. Work outward from the first sub-clause that
   evaluates differently from what you expected.
6. `cql_debug_stop`.

### A patient bundle doesn't trigger a population

1. Run the patient and note which defines are wrong.
2. Debug as above, with a breakpoint in the first define of the population's path.
3. For each define on the path, `cql_debug_evaluate` its expression and compare what the engine
   returns with the FHIR resources in the bundle. The first place they diverge is the missing or
   wrong resource, field or value.
4. `cql_debug_stop`.

### Two versions of a library

1. Run `cql_test_run_suite` before and after the edit. Each run moves the suite's `latest` pointer,
   and the old `latest` becomes `previous`.
2. `cql_test_list_runs` (`suiteName`, `limit`) lists the persisted runs, newest first.
3. `cql_test_diff` with `suiteName`, `runA` set to `previous` and `runB` set to `latest`. For two
   specific runs, pass a hash prefix (8 or more characters) or a timestamp as listed by
   `cql_test_list_runs`. Without an earlier run it returns a `no_previous_run` status, not an error.
4. The report has `added` and `removed` cases, `statusFlips`, and a `changed` list of
   `{ patientId, expressionName, before, after, kind }`. `kind` is `value-changed`,
   `expression-added` or `expression-removed`. The last two usually mean a define was added,
   renamed or removed in the CQL.

### Compile inspection

`cql_view_elm` with `elmType` `ast` or `json` shows how the compiler read the CQL, for example
whether a retrieve compiled to a value set reference against the expected value set, or a fluent
function was resolved. `xml` is the default.

## Debugging rules

- **One session at a time.** `cql_debug_start` fails while a session is active ("call
  cql_debug_stop first"). It does the connection and launch in a single call, so you don't set
  anything up separately.
- **Always end with `cql_debug_stop`.** It does nothing if the session already ended. A session
  also ends by itself when the library finishes or the language server goes away, after which
  `cql_debug_start` can be called again.
- **Breakpoints go on expression lines**, not on the `define "X":` line. The language server only
  stops on expression lines. `cql_debug_set_breakpoints` (and the `breakpoints` argument of
  `cql_debug_start`) may report `verified: true` for a `define` line, and the server marks it
  unverified later.
- **A resume that ends the session without stopping.** When breakpoints were set, the result has a
  `note`, `unverifiedBreakpoints` and `errors` (the `Error` entries from re-running the library
  with the launch settings). Read `errors` first: a compile failure, such as a missing `rootDir`,
  looks the same as breakpoints that never hit. With no breakpoints set the `note` is
  "terminated (no breakpoints set)".
- **Timeouts are not errors.** `cql_debug_continue`, `cql_debug_next`, `cql_debug_step_in` and
  `cql_debug_step_out` wait up to 30 seconds (`timeoutMs` overrides) and then return
  `event: "timeout"` with the session still alive and paused.
- **Variables.** `cql_debug_get_variables` takes `frameId` (expands that frame's scopes) or
  `variablesReference` (expands one subtree): pass exactly one. Large variables are cut to
  `maxChars`; the dropped ones are listed in `omittedVariables`, so fetch a subtree instead.
- **Parameters.** `cql_debug_start`, `cql_execute` and the test-run tools take
  `parameters` as `[{ name, type, value }]`, with `value` as a string. `cql_debug_start` also
  accepts an object keyed by parameter name.

## Output size

`cql_view_elm`, `cql_execute` and `cql_debug_get_variables` take `maxChars` (at least 1000, default
50000). A longer result comes back with `truncated: true`, `totalChars` and `maxChars`:

- `cql_view_elm` cuts `content`.
- `cql_execute` drops trailing expression results (named in `omittedExpressions`, with
  `omittedCount`) and counts dropped log lines in `omittedLogLines`. Diagnostics are always kept.
- `cql_debug_get_variables` drops trailing variables (`omittedVariables`).

To see the rest, raise `maxChars` or narrow the request, for example with fewer `contextValues`.

## Worked example

A measure in an IG at `<IG_ROOT>`, library `<LIBRARY>`, tests at `<IG_ROOT>/input/tests/measure/<LIBRARY>/`:

1. `cql_validate` with `cqlFile` `<IG_ROOT>/input/cql/<LIBRARY>.cql`. Fix any diagnostics.
2. `cql_test_run_suite` with `cqlFile` the same file, `suiteRoot` `<IG_ROOT>/input/tests/measure`
   and `suiteName` `<LIBRARY>`.
3. Compare each case's per-define values with its expected results and report each patient where a
   define disagrees, giving actual and expected, grouped by define.
4. For the first disagreement, follow the regression playbook.
