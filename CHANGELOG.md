# Changelog

All notable changes to `@cqframework/cql-mcp` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until the npm package is published,
releases are distributed as tarballs attached to
[GitHub releases](https://github.com/cqframework/cql-mcp/releases).

## [0.1.0-rc.2] - 2026-11-12

### Added

- The server sends `instructions` in its `initialize` result: a short guide (at most 2,000
  characters) to tool selection and the validate, run, test-and-diff and debug workflows. Every
  MCP client that supports instructions receives it with nothing to install (ADR-0005).
- A Claude skill, `skills/cql-mcp/SKILL.md`, with scenario playbooks, debugging rules and a worked
  example. Each GitHub release attaches it as `cql-mcp-skill.zip`. It isn't in the npm package.
- A unit test fails when the instructions or the skill name a tool or an argument that the server
  doesn't register.
- README setup for Claude Code, Claude Desktop, VS Code (GitHub Copilot), OpenCode and ChatGPT.

### Changed

- The README's "Prompting agents" section is replaced by a short "Agent guidance" section that
  links to the skill. Its stale claims were corrected as part of the move.

## [0.1.0-rc.1] - 2026-11-11

First release candidate of `@cqframework/cql-mcp`, previously the unpublished `mcp-cql-debug`.
It is distributed from GitHub until the npm package is published.

### Added

- 19 MCP tools over stdio for CQL validation, ELM inspection, execution, test suite runs and
  diffs, and DAP debugging, backed by cql-language-server 5.0.0.
- The server answers `initialize` immediately and resolves Java and the language server jar on
  first use. `cql_get_status` reports progress under `runtime` (ADR-0001).
- The jar is resolved in order from `CQL_LS_JAR_PATH`, the `~/.cql-mcp/jars` cache, a matching
  vscode-cql jar, `CQL_LS_MAVEN_REPO`, a `settings.xml` mirror and Maven Central. Downloads honour
  `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` and are checked for integrity. Credentials are
  redacted from errors and logs.
- Every tool declares annotations. `cql_view_elm`, `cql_execute` and `cql_debug_get_variables`
  bound their output with `maxChars` (default 50,000) and mark truncated results (ADR-0004).
- CI on Ubuntu, macOS and Windows with Node 22 and 24, and a restricted-network E2E workflow.

### Changed

- Tool failures, including invalid arguments, are returned as `isError` results that the model
  can read, instead of JSON-RPC errors. Arguments are validated against zod schemas (ADR-0004).
- Environment variables are renamed to `CQL_MCP_WORKSPACE`, `CQL_MCP_LOG_FILE`,
  `CQL_MCP_LOG_LEVEL` and `CQL_MCP_JAR_DIR`.
- Paths are handled in the host's native form only (ADR-0003).

### Removed

- The `CQL_DEBUG_MCP_*` environment variables and the `~/.cql-debug-mcp/jars` cache.

### Fixed

- `cql_debug_set_breakpoints` no longer throws on malformed `lines`. `cql_debug_start` accepts
  `parameters` as an array of `{name, type, value}` or as an object.
- On Windows, `cql_validate` with a relative path now finds the library's diagnostics.
- `cql_get_status` no longer restarts a failed resolution on every call; retries back off from
  5 s to 60 s.
- A language server crash is reported in a readable sentence, with the exit code and restart
  behaviour.

[0.1.0-rc.2]: https://github.com/cqframework/cql-mcp/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/cqframework/cql-mcp/releases/tag/v0.1.0-rc.1
