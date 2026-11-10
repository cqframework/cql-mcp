---
title: "ADR-0004: MCP Tool Contract (Errors, Validation, Annotations, Output Size)"
status: "Accepted"
date: "2026-11-10"
tags: ["mcp", "tools", "errors", "validation", "zod", "annotations"]
---

## 1. Context

cql-mcp's 19 tools are an agent-facing API. Today, how they behave at the edges is
inconsistent, and in places it doesn't follow the MCP specification (2025-11-25):

- **Errors.** Every handler failure is rethrown as a JSON-RPC
  `McpError(InternalError, -32603)` (`src/index.ts`). That includes bad input, a missing file, a
  CQL problem, a missing JDK, and a language-server crash. The spec says tool execution errors,
  input validation errors included, should come back as a result with `isError: true`, so the
  model can read the message and try again. JSON-RPC errors are meant for protocol problems such
  as an unknown tool or a malformed request. Many clients show a `-32603` as an opaque failure
  and never pass the message to the model.
- **Validation.** Hand-written checks (`missing`, `expectString`) cover only some arguments. As a
  result, `cql_debug_set_breakpoints` with `lines: "5"` crashes with
  `TypeError: args.lines.filter is not a function`, `cql_execute` doesn't check
  `contextValues` or the shape of `parameters`, and a negative `cql_test_list_runs` `limit`
  silently drops runs. `cql_debug_start` takes `parameters` as `{name: value}` while the other
  tools take `[{name, type, value}]`.
- **Annotations.** No tool declares `readOnlyHint`/`destructiveHint`/`idempotentHint`/
  `openWorldHint`, so clients can't tell safe inspection tools from state-changing ones.
- **Output size.** Results are sent as pretty-printed JSON. `cql_view_elm`, `cql_execute` and
  `cql_debug_get_variables` have no size limit, so one call can use up a large share of the
  model's context. Only `validate_resources` has a cap, and it lives on a feature branch.

SDK 1.32.2 provides `McpServer.registerTool` with zod input schemas, annotations and an optional
`outputSchema`. zod 4 is already installed as an SDK dependency.

## 2. Decision

### 2.1 Tool failures are results, not protocol errors

- Every failure inside a tool comes back as
  `{ isError: true, content: [{ type: "text", text: <message> }] }`. That covers invalid
  arguments, runtime and dependency resolution errors (ADR-0001), CQL and LS errors, and LS
  crashes. The message is written for the model: what failed, and what to do about it where
  that's known (for example "Set JAVA_HOME…").
- An LS crash also includes the crash details (exit code, signal, last stderr lines) as JSON
  after the message.
- JSON-RPC errors are only for protocol failures: a malformed request, or a server-internal
  fault outside any tool.
- **An unknown tool name is an `isError` result**, because that's what the SDK's own `tools/call`
  handler (1.32.2) does. The MCP spec lists unknown tools as a protocol error, but we accept the
  SDK's behaviour rather than replacing its handler (§2.2). The message names the tool, which also
  helps the model correct itself.
- No error text ever contains credentials (ADR-0001 §2.6 redaction still applies).

### 2.2 Inputs are declared with zod through `McpServer.registerTool`

- The low-level `Server` with hand-written dispatch is replaced by `McpServer.registerTool`. Each
  tool declares a zod input shape, and the descriptions are carried over from today's JSON
  schemas word for word unless they're wrong.
- Handlers keep their `(ctx, args)` shape. A thin adapter registers them, and it alone maps
  thrown errors to §2.1 results.
- The SDK's own `tools/call` handler does the validation. In 1.32.2 it returns a zod failure as
  an `isError` result (checked 2026-11-10), so §2.1 holds with no custom code. cql-mcp **does not
  replace** that handler, and doesn't reach into `server.server`. That keeps SDK upgrades safe,
  and lets the SDK's `outputSchema` checking work when `structuredContent` is adopted.
- `missing()`/`expectString()` are deleted once nothing uses them.
- `cql_debug_start.parameters` accepts **both** `{name: value}` and `[{name, type, value}]`, and
  normalizes them to one internal form. The array form is the one documented.
- `tools/list` is a contract. A unit test snapshots each tool's name, description, required
  arguments and argument names. Any change to it shows up in review.

### 2.3 Every tool declares annotations

| Tools | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- |
| `cql_get_status`, `cql_get_signatures`, `cql_resolve_includes`, `cql_validate`, `cql_view_elm`, `cql_execute`, `cql_test_list_runs`, `cql_test_diff` | true | false | true | false |
| `cql_debug_*` (start, set_breakpoints, continue, next, step_in, step_out, get_variables, evaluate, stop) | false | false | false | false |
| `cql_test_run_file`, `cql_test_run_suite` (write run records under `.cql-debug/test-runs/`) | false | false | false | false |

`openWorldHint` is false throughout. The first call may download the LS jar (ADR-0001), but that
is incidental to setup, not what the tool is for. A tool that reaches an external system as
part of its job, such as `cql_test_validate_resources` with a `QUICK`/`FULL` profile on the
feature branch, sets `openWorldHint: true`. "Read-only" means the user's files and the CQL
project. The LS's in-memory document state and cql-mcp's own caches don't count.

### 2.4 Output is compact and bounded

- Results are serialized as compact JSON (`JSON.stringify(result)`), with no indentation.
- `cql_view_elm`, `cql_execute` and `cql_debug_get_variables` accept an optional `maxChars`,
  default **50,000**, with a minimum of 1,000. When the serialized result is longer, they return
  a truncated result marked `truncated: true` with `totalChars`, so the model knows it can ask
  again with a larger `maxChars` or narrow the request.
- `outputSchema`/`structuredContent` are **deferred**. When they're adopted, the text `content`
  block stays alongside them, as the spec requires for clients that don't read
  `structuredContent`.

## 3. Alternatives Considered

* **Replace the SDK's `tools/call` handler** to make unknown tools a JSON-RPC error and to
  control message wording. **Rejected** (2026-11-10). It would depend on SDK internals
  (`server.server`), and we'd have to reimplement SDK behaviour such as `outputSchema`
  validation, all for a small spec difference.
* **Keep the low-level `Server` and add hand-written checks.** **Rejected.** The validation would
  keep drifting from the declared JSON schema, and every new tool would need its own checks.
* **Use `InvalidParams` (-32602) for bad input.** **Rejected.** The current spec puts input
  validation errors in tool results so the model can retry.
* **Add `structuredContent` now.** **Deferred.** It needs an `outputSchema` for each of the 19
  tools. Compact JSON brings most of the token saving at once, and works in every client.
* **Truncate by tokens instead of characters.** **Rejected.** Counting tokens would need a
  tokenizer dependency and depends on the model. A character count is predictable and good
  enough.

## 4. Consequences

* **Positive:** Models see every failure message and can fix their own input and try again. A
  `TypeError` is no longer possible from a wrong argument type.
* **Positive:** Clients can auto-approve the read-only tools and ask before state-changing ones.
* **Positive:** Large ELM or variable dumps can no longer swamp the model's context without
  warning.
* **Negative:** It's a visible contract change. Clients that matched on `-32603` will see
  `isError` results instead, and pretty-printed output is gone. That's acceptable before the
  first npm release.
* **Negative:** zod becomes a direct dependency, pinned to the version the SDK already uses.

## 5. Agent Directives

* **MUST** return tool failures as `isError: true` results. **MUST NOT** throw `McpError` from a
  tool handler.
* **MUST NOT** replace or wrap the SDK's `tools/call` request handler. Register tools only through
  `McpServer.registerTool`.
* **MUST** declare every tool input with zod, and annotations from §2.3, when adding or changing a
  tool. A new tool needs its row in the §2.3 table.
* **MUST** bound any tool output that can grow with the size of the input (§2.4).
* **MUST** update the `tools/list` contract snapshot on purpose, never as a side effect.
