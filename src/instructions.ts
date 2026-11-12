/**
 * Sent to every MCP client in the `initialize` result (ADR-0005). Workflow and selection rules only,
 * at most 2,000 characters (checked by test/unit/instructions.test.ts); argument details belong in
 * the zod schemas, and longer playbooks in skills/cql-mcp/SKILL.md.
 */
export const SERVER_INSTRUCTIONS = `cql-mcp runs, inspects and debugs HL7 CQL (Clinical Quality Language) through the CQL language server. The workspace is the CQL project root (the server's working directory, or CQL_MCP_WORKSPACE). Failures come back as isError results.

Setup: Java and the language-server jar are resolved on first use, and that can download the jar. If a first call is slow or fails, call cql_get_status and check runtime.state.

Choosing tools:
- Understand a library: cql_get_signatures (defines, functions, compiled types) and cql_resolve_includes (included libraries' public interface). Use these instead of reading large helper libraries such as FHIRHelpers.
- Check edits: cql_validate before running anything. It takes unsaved text as \`content\`.
- Compile inspection: cql_view_elm (elmType xml, json or ast).
- Run: with test-case bundles, prefer cql_test_run_suite (suiteRoot, suiteName) or cql_test_run_file, which persist runs; then cql_test_list_runs and cql_test_diff (suiteName, runA "previous", runB "latest"). Use cql_execute for a quick one-off. A passed status means the run had no errors, not that results match expected values; compare them yourself.

Debugging a surprising result: cql_debug_start (testCaseDir for a patient bundle), cql_debug_set_breakpoints on expression lines (never the define line), cql_debug_continue, cql_debug_next, cql_debug_step_in or cql_debug_step_out, then cql_debug_get_variables and cql_debug_evaluate. Always finish with cql_debug_stop; only one session can be active.

Output with truncated: true is incomplete. Raise maxChars or narrow the request.

If the cql-mcp skill is installed, use it for step-by-step playbooks.`;
