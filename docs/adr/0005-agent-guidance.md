---
title: "ADR-0005: Agent Guidance (Server Instructions and a Claude Skill)"
status: "Accepted"
date: "2026-11-11"
tags: ["mcp", "agents", "instructions", "skills", "documentation"]
---

## 1. Context

cql-mcp's users are mostly agents, and today the only guidance an agent sees is the 19 tool
descriptions. Those describe each tool on its own. They don't say which tool to choose, in what
order to use them, or what to avoid, for example:

- validate before running
- inspect helper libraries through signatures instead of reading them in full
- prefer the test pipeline when bundles exist
- always end a debug session

That guidance exists, but in the wrong place. The README's "Prompting agents" section (about 150
lines) has:

- a tool-selection cheatsheet
- static-versus-runtime advice
- five scenario playbooks
- tips, gotchas
- a worked CMS645 example

It's written for people, and no agent reads it. Parts of it are out of date: it predates the
ADR-0001 lazy runtime, the ADR-0004 tool contract and the per-client install docs. It also mixes in
a contributor note (the LS logback/stdout problem) that agents don't need.

There are three ways to put guidance in front of an agent:

- **Server `instructions`.** A string in the `initialize` result (MCP 2025-11-25). It arrives with
  the server, needs no installation, and is read by clients that support it, Claude Code included.
  Clients may add it to the model's context in full on every session, so it has to be short.
- **A Claude skill (`SKILL.md`).** Claude Code and Claude Desktop load a skill only when a task
  matches its description, so length costs nothing until it's used. It only reaches Claude, and it
  has to be installed.
- **MCP prompts.** These are reusable, user-invoked templates, shown as slash commands in some
  clients. They suit workflows people repeat. We don't yet know which ones those are.

## 2. Decision

### 2.1 Two layers

- **`instructions` is the portable minimum.** It's a short guide every client receives, covering:
  - what the server is for
  - the workspace
  - tool selection
  - the order of the main workflows (validate, run, test and diff, debug)
  - the rules that prevent the most common mistakes: always `cql_debug_stop`, breakpoints go on
    expression lines, and how to handle truncated output
- **The skill is the depth, for Claude.** `skills/cql-mcp/SKILL.md` holds the scenario playbooks,
  the static-versus-runtime advice, tips, gotchas and worked examples.
- **Tool descriptions stay self-contained.** Each tool must still be usable correctly from its own
  description and schema, by a client that ignores `instructions` and has no skill. Neither layer
  may become the only place a tool's correct use is documented.

### 2.2 `instructions` budget

- At most **2,000 characters**, checked by a unit test.
- It contains workflow and selection rules only. Argument details belong in the zod schemas
  (ADR-0004 §2.2), not in `instructions`.
- It can mention the `cql-mcp` skill for longer playbooks, but must make sense without it.

### 2.3 One home per fact

- **Agent usage guidance** lives in the skill. The README keeps a short "Agent guidance" section:
  what the instructions are, the tool-selection cheatsheet, and how to install the skill. It links
  to the skill instead of copying it.
- **CQL language knowledge** (syntax, semantics, FHIR and QI-Core patterns) is out of scope for
  this skill. It belongs to separate CQL skills, which this one may point to.
- **Contributor notes**, such as the LS logback/stdout gotcha, belong in the README's build and
  contributor material, not in agent guidance.

### 2.4 Drift guard

A unit test fails when `instructions` or `SKILL.md`:

- names a `cql_*` tool that isn't registered
- or names an argument that isn't in that tool's schema. This check uses a hand-listed set of
  (tool, argument) pairs taken from the text.

Renaming a tool or an argument breaks the guidance in the same PR, not silently later.

### 2.5 Distribution

- `instructions` ships in the server itself.
- The skill sits in the repo at `skills/cql-mcp/`. A zip of it (`cql-mcp-skill.zip`) is attached to
  each GitHub release, for Claude Desktop upload and for copying into `~/.claude/skills/` or a
  project's `.claude/skills/`.
- The skill is **not** in the npm tarball. Files inside an `npx` cache aren't somewhere users can
  find or install from.
- A Claude Code plugin that bundles the server with the skill is deferred until the npm package is
  published.

## 3. Alternatives Considered

* **Instructions only.** **Rejected.** The playbooks are far beyond any reasonable budget, and
  putting them in every session's context would cost all users tokens on every task, CQL or not.
* **Skill only.** **Rejected.** It would reach only Claude users who install it. VS Code, OpenCode
  and ChatGPT users would get no guidance at all.
* **Longer tool descriptions instead.** **Rejected.** Cross-tool workflow doesn't belong to any one
  tool. Repeating it in each description inflates every `tools/list` and still doesn't give an
  order.
* **Keep the README section and copy it into the skill.** **Rejected.** Two copies drift; the README
  copy has already drifted.
* **MCP prompts now.** **Deferred.** They need real usage to show which workflows are worth fixing
  as templates.
* **Ship the skill in the npm tarball.** **Rejected.** It isn't discoverable there (§2.5).

## 4. Consequences

* **Positive:** Every client gets the core workflow rules with nothing to install. Claude users who
  install the skill get the full playbooks, loaded only when relevant.
* **Positive:** The guidance is checked against the real tool surface, and the stale README text is
  corrected as part of the move.
* **Negative:** The skill is one more artifact to release (a zip per release) and to keep accurate.
  The drift test catches renamed tools and arguments, not changed behaviour.
* **Negative:** Guidance is split across two places. Contributors need to know which layer a new
  rule goes in (§2.1–§2.2).

## 5. Agent Directives

* **MUST** keep `SERVER_INSTRUCTIONS` within 2,000 characters, limited to workflow and selection
  rules.
* **MUST** update `instructions` and/or `SKILL.md` in the same change when a tool is added,
  renamed or removed, or its workflow changes. The drift test must pass.
* **MUST NOT** make `instructions` or the skill the only place a tool's correct use is documented.
  Tool descriptions and schemas stay self-contained (§2.1).
* **MUST NOT** copy skill content back into the README. Link to it instead.
* **MUST NOT** put CQL language guidance or contributor notes in the cql-mcp skill (§2.3).
