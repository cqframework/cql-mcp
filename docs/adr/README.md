# Architecture Decision Records

This folder records the significant design decisions for cql-mcp: what was decided, why, and
what was rejected.

## Conventions

- One decision per file, named `NNNN-kebab-case-title.md` and numbered in order.
- YAML frontmatter with `title`, `status`, `date` and `tags`.
- Status is `Proposed`, `Accepted`, `Deprecated` or `Superseded by ADR-NNNN`.
- Sections: Context, Decision, Alternatives Considered, Consequences, Agent Directives.
- Accepted ADRs aren't rewritten. To change a decision, write a new ADR that supersedes it, and
  update the old one's status.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-runtime-dependency-resolution.md) | Runtime dependency resolution (Java and the CQL Language Server jar) | Accepted |
| [0002](0002-language-server-runtime-network-access.md) | Language server runtime network access (moved to cql-language-server ADR-0001) | Superseded by cql-language-server ADR-0001 |
| [0003](0003-host-native-path-handling.md) | Host-native path handling | Accepted |
| [0004](0004-mcp-tool-contract.md) | MCP tool contract (errors, validation, annotations, output size) | Accepted |
