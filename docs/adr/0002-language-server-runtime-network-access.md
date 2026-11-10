---
title: "ADR-0002: Language Server Runtime Network Access (moved)"
status: "Superseded by cql-language-server ADR-0001"
date: "2026-11-10"
tags: ["fhir-packages", "proxy", "tls", "jvm", "restricted-networks"]
---

## Moved

This decision covers how the language server itself reaches the network: FHIR package
registries, proxies and TLS. That behaviour belongs to cql-language-server, so the ADR was moved
there and accepted on 2026-11-10:

- [cql-language-server ADR-0001: Runtime Network Access](https://github.com/cqframework/cql-language-server/blob/master/docs/adr/0001-runtime-network-access.md)
- Tracking issue: [cql-language-server#158](https://github.com/cqframework/cql-language-server/issues/158)
- Field report: [vscode-cql#106](https://github.com/cqframework/vscode-cql/issues/106)

For cql-mcp, the part that matters is the LS ADR's §2.5, "Client contract". When cql-mcp starts
the LS, it passes the user's network settings to the JVM:

- `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` become JVM proxy properties
- `CQL_LS_FHIR_SETTINGS` becomes `-Dfhir.settings.path`
- `CQL_LS_JAVA_OPTS` is passed through as JVM options, and wins over the mapped values

Credentials are never logged.
