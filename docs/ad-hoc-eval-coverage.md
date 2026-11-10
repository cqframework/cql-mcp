# Tier B runbook — ad-hoc evaluate live coverage (`adHocEvalCoverage`)

Repeatable end-to-end check of the CQL debugger's ad-hoc evaluate path (Debug Console) against a
**real launched JVM + DAP session**, mirroring Tier A's `StreamingCqlDebugServerAdHocFixtureTest`
rows. The authoritative matrix (row → Tier A test → Tier B step) is
`cql-language-server/ls/server/src/test/kotlin/org/opencds/cqf/cql/debug/AD_HOC_EVAL_COVERAGE.md`.

## Fixtures

Copied 1:1 from `cql-language-server/ls/server/src/test/resources/org/opencds/cqf/cql/ls/server/`
into `cql-mcp/test/fixtures/ad-hoc-eval/`:

`AdHocQueryBasics.cql`, `AdHocTerminology.cql`, `AdHocOperandTypes.cql`, `AdHocFhirQuery.cql`,
`AdHocVitalSigns.cql`, `AdHocIncludingLib.cql`, `AdHocIncludedLib.cql`

**Keep the copies in sync** when the LS-side fixtures change (the automated test loads them from
the cql-mcp dir). `AdHocTerminology.cql` deliberately keeps its defines in sorted-by-name
order — see matrix gap 3.

## Prerequisites

- Node ≥ 18, and a JVM (any JDK 17+ the debug server runs on).
- The `cql-ls-server` JAR the MCP server will spawn. `findJar()` (in the test) prefers
  `CQL_LS_JAR_PATH`, then scans `../vscode-cql/dist/java-support/jars/` (a `vscode-cql` checkout
  next to this repo) → `dist/java-support/jars/` (in this repo) for `cql-ls-server-*.jar`.

Getting a JAR (pick one):

1. **Reuse one from a sibling vscode-cql checkout**: `vscode-cql/dist/java-support/jars/cql-ls-server-<version>.jar`,
   already present after a vscode-cql packaging run; the test finds it with no env vars. Verify it is
   not older than the debug-server sources you care about:
   `ls -la vscode-cql/dist/java-support/jars/` vs
   `ls -la cql-language-server/ls/server/src/main/kotlin/org/opencds/cqf/cql/debug/CqlDebugServer.kt`.
2. **Point at a fresh build**: from a `cql-language-server` checkout run
   `./mvnw package -DskipTests`; the fat JAR lands at
   `ls/server/target/cql-ls-server-<version>.jar`; then
   `export CQL_LS_JAR_PATH="$PWD/ls/server/target/cql-ls-server-<version>.jar"`.

## Running

From the repo root:

```sh
npm run test:integration -- --grep adHocEvalCoverage
```

`test:integration` compiles TS first (`tsc -p tsconfig.json`), so a fixture copy, a new step, or a
runbook change that touches the test needs no separate build step. Each `it` boots its own LS
process + DAP session. With the shared 180s mocha timeout, the whole file runs in ~1–2 min; expect
a fair number of JVM/GC slack lines on stderr (the test tees stderr to the reporter).

To run against a specific Java home: `JAVA_HOME=/path/to/jdk npm run test:integration -- --grep adHocEvalCoverage`.

## What the automated check pins (step → matrix row)

| Step | Fixture / pause point | Expression | Pins |
|---|---|---|---|
| TB-01 | QueryBasics / line 4 ("Items") | `1 + 2` | `3` (matrix 1) |
| TB-02 | QueryBasics | `Count("Items")` | `3` (4) |
| TB-03 | QueryBasics | `Count(from "Items" I where I.score >= 90)` | `2` (5) |
| TB-04 | QueryBasics | `Count(from "Items" I let Doubled: … where Doubled > 180)` | `2` (6) |
| TB-05 | QueryBasics | `exists (from "Items" I where I.score >= 95)` | `true` (7) |
| TB-06 | QueryBasics | `First(from "Items" I sort by score desc).name` | `'charlie'` (8) |
| TB-07 | QueryBasics | `Interval[1, 10]` | `[1, 10]` (9) |
| TB-08 | QueryBasics | `Tuple { a: 1, b: 'two' }` | `Tuple { a: 1, b: 'two' }` (9) |
| TB-09 | QueryBasics | `Count("No Such Define")` | `Compile error:` prefix (missing identifier) |
| TB-10 | Terminology / line 16 ("Choice Shaped") | `First({ "Systolic BP Code" }).code` | `'8480-6'` (10) |
| TB-11 | Terminology | `Count("Quantity Alias")` | `2` (11) |
| TB-12 | Terminology | `Count("Nested Tuples")` | `2` (12) |
| TB-13 | Terminology | `"Code Selector".code` | `Identifier doesn't exist (CQL is case-sensitive)` (13, gap 2) |
| TB-14 | VitalSigns / line 18 ("Blood Pressure Reading") | `exists (({ "Systolic blood pressure", "Diastolic blood pressure" }) C where C ~ …)` | `true` (34) |
| TB-15 | VitalSigns | negative `~` variant | `false` (34) |
| TB-16 | FhirQuery / line 12 | `1 + 2` in `using FHIR` | `3` (26) |
| TB-17 | FhirQuery | `Exists(from [Encounter] E)` | **record only** — live data-provider dependent (27) |
| TB-18a/b/c | Including → **primary** paused (`AdHocIncludingLib.cql:6`) | `Count(AdHocIncludedLib."Tuple Items")` → `2`; `AdHocIncludedLib."Tuple Items"[0].id` → `1`; bare `AdHocIncludedLib."Tuple Items"` evaluates to the tuple list | across-include qualified define refs (23/24 reachable subset; bare qualified-delimited root is **not** identifier-shaped — contrast TB-13) |

### Deliberately not pinned live (why)

- **`watch` (matrix rows 1–3)**: `DapSession.evaluate(expression, frameId)` always sends
  `context: 'repl'` (`dapSession.ts:224`), so Tier B cannot cross into the watch half of the
  matrix. Watch stays JUnit-only (`G1` in Tier A).
- **Retrieve rows (matrix 27, 28, 35) "Runtime error"**: that degradation is a no-data-provider
  artifact of the Tier A test harness. A **live LS session binds an (empty) data provider instead** —
  observed: TB-17 `Exists(from [Encounter] E)` → `false` (empty result), not `Runtime error`. So
  Tier B records the live value (TB-17) and the JUnit suite pins the harness degradation; the
  runbook's job is to tell you which of the two you're seeing, not to pretend they're equal.
- **Alias-value rows that need a registered stack variable with a specific runtime type (G3:
  matrix 14–22)**: they bind a synthetic operand through `convertToAdHocOperandValue`; driving the
  *exact* runtime value live would need a fixture whose data lands in that exact paused state.
  JUnit-only by design.

## Manual live checks (gap chasing)

Anything the automated file can't reach but the debugger supports can be chased in a live session
(`cql_debug_start` / `cql_debug_continue` / `cql_debug_evaluate` with a frameId):

1. **Included-library probe (the frame TB-18 can't reach)**: launch `AdHocIncludingLib.cql` with
   `rootDir=cql-mcp/test/fixtures/ad-hoc-eval`, break at `AdHocIncludedLib.cql:8` (alias `T`
   of "Tuple Alias Query" — Tuple-typed). Evaluate both `T.id > 0` (bare key) and
   `AdHocIncludedLib.T.id > 0` (qualified) to observe which key the live registry uses. The
   qualified key is the one that hits `noResolvableTypeResponse`
   (`CqlDebugServer.kt:1437-1444`) — pins the TODO at `variableTypeMap` (primary-library-only).
   **Caveat**: the streaming handler doesn't pause on breakpoints in the included library's file
   (CONTINUE mode logs `libBreakpoints=null` for included libs), so this needs a session whose
   engine parks inside the included library some other way (e.g. a step-into from the including
   lib's `AdHocIncludedLib."Tuple Items"` reference).
2. **Watch-context spot check**: use the VS Code extension's Debug Console (`cql.debug` commands)
   which sends `context: 'watch'` — Tier B cannot, but a human can confirm the G1 rows match Tier A.

## Troubleshooting

- **`Tests run … 0` / all `it`s skipped** — `findJavaRuntime` or `findJar` returned null. Check
  `JAVA_HOME` and the JAR candidates above.
- **`Test timeout exceeded` on TB-18** — the include didn't resolve (`rootDir` misconfigured) or the
  primary pause at `AdHocIncludingLib.cql:6` didn't fire in this JAR; verify the JAR is newer than
  the `CqlDebugServer.kt`/`StreamingBreakpointHandler.kt` changes and check the stderr tee for the
  resolution errors. The tuple-alias *frame* (rows 23/24 exact) is deliberately not in the automated
  file — see the manual probe.
- **TB-14/15 fail but `Exists` helpers work in Tier A** — the VitalSigns pause didn't land (retrieve
  with no provider may complete without stopping); use a different pause line inside the fixture.
- **A step returns `not available`** — the ad-hoc eval timed out waiting for the parked engine
  thread; retry the run (transient), or check the LS log for a hung engine thread.