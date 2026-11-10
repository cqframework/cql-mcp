---
title: "ADR-0001: Runtime Dependency Resolution (Java and the CQL Language Server Jar)"
status: "Proposed"
date: "2026-11-09"
tags: ["dependencies", "distribution", "jar", "maven", "npm", "restricted-networks"]
---

## 1. Context

cql-mcp is distributed as an npm package (`@cqframework/cql-mcp`, run with `npx`). It drives
the CQL Language Server (`cql-ls-server`) as a JVM child process, so at runtime it needs two
things npm doesn't provide:

1. **A Java runtime**, JDK 17 or newer (`REQUIRED_JDK_VERSION`, `src/jvm/javaLocator.ts`).
2. **The `cql-ls-server` jar**, `org.opencds.cqf.cql.ls:cql-ls-server:<version>` on Maven Central.

Facts that shape the decision:

- **The jar is self-contained.** `cql-ls-server` is built with `maven-shade-plugin` without
  `shadedArtifactAttached`, so the artifact published to Central *is* the fat jar (about 210 MB).
  It bundles `clinical-reasoning`, `clinical_quality_language` (cql-to-elm, engine) and HAPI FHIR.
  Those libraries live in `~/.m2` only for people who build the language server. Running the jar
  needs nothing from a Maven repository.
- **No tool puts the LS jar in `~/.m2`.** vscode-cql downloads it straight from
  `https://repo1.maven.org/maven2/...` into its own extension folder
  (`<extension>/dist/java-support/jars/`, see `javaServiceInstaller.ts`). It never runs Maven and
  never touches the local repository. The jar reaches `~/.m2` only if someone runs `mvn install` on
  cql-language-server (a `-SNAPSHOT` version) or `mvn dependency:get` by hand.
- **VS Code deletes extension folders on update**, so a jar under `~/.vscode/extensions/` can
  disappear at any time.
- **Corporate networks often block Maven Central.** Developers there have to use an internal
  Artifactory/Nexus mirror, usually set up in `~/.m2/settings.xml` with credentials, behind an
  HTTP proxy, sometimes with a corporate TLS root
  ([vscode-cql#94](https://github.com/cqframework/vscode-cql/issues/94)).
- **MCP clients time out on `initialize`.** A first run that downloads 210 MB before answering
  `initialize` shows up in the client as `CONNECTION_CLOSED`.
- **Node's built-in `fetch` ignores `HTTPS_PROXY`.** VS Code's proxy patching only applies to
  extensions, not to a standalone process like cql-mcp.

## 2. Decision

### 2.1 Don't bundle the jar; pin a released version

The npm package contains no jar. cql-mcp resolves exactly one LS version at runtime: the
`DEFAULT_CQL_LS_VERSION` constant (a released version, currently `5.0.0`), unless the user sets
`CQL_LS_VERSION`. A `-SNAPSHOT` version is never downloaded; SNAPSHOTs only work through
`CQL_LS_JAR_PATH`.

### 2.2 Resolve after connecting

The MCP transport connects first. Locating Java and resolving the jar happen lazily, on the first
tool call that needs the language server. `cql_get_status` reports the progress and the outcome,
including which source supplied the jar (`jarSource`).

### 2.3 Jar resolution order (first match wins)

| # | Source | Use |
| --- | --- | --- |
| 1 | `CQL_LS_JAR_PATH` | Run in place |
| 2 | cql-mcp cache: `<CQL_MCP_JAR_DIR or ~/.cql-mcp/jars>/cql-ls-server-<ver>.jar` | Run in place |
| 3 | Legacy cache `~/.cql-debug-mcp/jars/` (only when `CQL_MCP_JAR_DIR` is unset) | Run in place |
| 4 | vscode-cql jar: `~/{.vscode,.vscode-insiders,.vscode-server,.vscode-oss}/extensions/cqframework.cql-*/dist/java-support/jars/cql-ls-server-<ver>.jar`, exact version only | **Copy** into the cache, then run from the cache |
| 5 | Download from `CQL_LS_MAVEN_REPO`, only when it is set (optional `CQL_LS_MAVEN_USERNAME`/`CQL_LS_MAVEN_PASSWORD`) | Into the cache |
| 6 | Download from the `settings.xml` mirror whose `<mirrorOf>` matches `central`, with credentials from the `<server>` that has the same `<id>` | Into the cache |
| 7 | Download from Maven Central | Into the cache |

Each download URL is tried once. If every source fails, one error lists each path and URL that
was tried and why it failed, without credentials.

### 2.4 Use `settings.xml` for network setup, not as a jar source

cql-mcp reads `~/.m2/settings.xml` (or `CQL_LS_MAVEN_SETTINGS`), plus the global
`$MAVEN_HOME/conf/settings.xml` (or `$M2_HOME/conf/settings.xml`), **only for `<mirrors>` and
`<servers>`**. Those tell it *where to download from* on a restricted network. It does **not**
look in the local Maven repository (`<localRepository>`, `~/.m2/repository`), and it ignores
`<proxies>`.

### 2.5 Proxies and TLS from environment variables

All downloads use `undici`'s `fetch` with `EnvHttpProxyAgent`, which honors `HTTPS_PROXY`,
`HTTP_PROXY` and `NO_PROXY` in upper or lower case. Corporate TLS roots come from Node's standard
`NODE_EXTRA_CA_CERTS`. cql-mcp has no proxy-detection code of its own.

Proxy authentication is limited to **Basic** (`http://user:pass@host:port`). Proxies that need
NTLM, Kerberos or Negotiate aren't supported directly. For those, users run a local relay such as
[Px](https://github.com/genotrance/px) or [Cntlm](https://cntlm.sourceforge.net/) and point
`HTTPS_PROXY` at it. npm and most Node CLIs use the same workaround.

### 2.6 Download safety

Each download checks its SHA-1 against `<url>.sha1` and checks its size against `content-length`.
It aborts after a stall timeout (`CQL_LS_DOWNLOAD_TIMEOUT_MS`, default 60 s with no bytes). It
writes to a per-process temp file (`.part-<pid>`) that is renamed into place when complete, so a
partial or corrupt jar is never cached.

### 2.7 Java is located, never installed

Java comes from `JAVA_HOME`, then `PATH`, and must be version 17 or newer. cql-mcp reports a
missing or too-old JDK as a clear error. It never downloads a JDK.

### 2.8 npm dependencies are pinned exactly

Runtime npm dependencies are pinned to exact versions in `package.json`, and there is a committed
lockfile. Jar resolution adds `undici` and `fast-xml-parser`. `engines.node` is `>=22`, the oldest
Node line still supported (Node 18 and 20 are end-of-life), which also satisfies undici 7.

### 2.9 Testing

Resolution is tested in four layers:

1. **Unit tests** with injected `fetch`, `env` and home folder.
2. **Network integration tests** against local fake Maven repos, proxies and self-signed TLS
   servers. These need no JDK.
3. **A restricted-network E2E test.** A Docker Compose setup with no internet egress runs the packed
   tarball against a mirror, an authenticating proxy and a TLS-intercepting proxy.
4. **A short human checklist** for GUI clients, Windows antivirus and real restricted networks.

Layers 1–2 run on every PR on all three OSes. Layer 3 runs nightly and gates releases. A consumer
VPN such as ProtonVPN isn't a useful test environment: it tunnels traffic without blocking Central,
requiring a mirror, or intercepting TLS, so cql-mcp behaves just as it does on an open network.

## 3. Alternatives Considered

* **Bundle the jar in the npm package.** **Rejected.** Every `npx` cache would carry a 210 MB
  tarball, and every LS upgrade would need a new npm release.
* **Look in the local Maven repository (`~/.m2/repository`).** **Rejected.** No distribution
  channel puts the LS jar there (see Context). The only people who would hit this source are LS
  developers, whose local builds are `-SNAPSHOT` versions that don't match the pinned release
  anyway, and who can already use `CQL_LS_JAR_PATH`. Supporting it would mean parsing
  `<localRepository>`, filling in placeholders, normalizing Windows paths, and running a jar that
  an IDE or `mvn install` can overwrite (or, on Windows, be blocked from overwriting) at any time.
  That is a lot of code and risk for almost no users. This reverses an earlier draft of this
  design and the proposal in a vscode-cql#94 comment.
* **Resolve with Maven (`mvn dependency:get`).** **Rejected.** It needs Maven installed, which
  most CQL authors don't have, and it's slow to start.
* **Run the vscode-cql jar in place.** **Rejected.** VS Code deletes the extension folder on
  update, which would remove the jar under a running server. Copying it into the cql-mcp cache
  avoids that.
* **Built-in NTLM/Kerberos proxy auth.** **Rejected.** It would need native or SSPI-specific
  dependencies on each platform, and we have no corporate proxy to test against. A local relay
  (§2.5) covers the case, and that's what npm users on those networks already run.
* **Parse `settings.xml` `<proxies>`.** **Deferred.** Environment variables cover the common case,
  and every Node tool already uses them. Reconsider if users report proxies that are only
  configured in `settings.xml`.

## 4. Consequences

* **Positive:** `npx -y @cqframework/cql-mcp` works with no setup when Central is reachable, and
  works with no extra cql-mcp setup on networks that already have a Maven mirror configured.
* **Positive:** Users who already have vscode-cql at the same LS version don't download 210 MB again.
* **Positive:** The jar's provenance is easy to see (`jarSource` in `cql_get_status`, plus one
  aggregated error), which makes support on restricted networks much easier.
* **Positive:** The resolution order needs no configuration and doesn't rely on files that change
  outside cql-mcp's control. The one exception is `CQL_LS_JAR_PATH`, which the user sets on purpose.
* **Negative:** We maintain a minimal `settings.xml` reader (mirror matching, server credentials).
  Encrypted passwords (`settings-security.xml`) aren't supported; they are skipped with a warning.
* **Negative:** Two runtime npm dependencies are added, and Node 18 and 20 are no longer supported
  (end-of-life since April 2025 and April 2026).
* **Negative:** Each LS version cached in `~/.cql-mcp/jars` uses about 210 MB until the user
  removes it.
* **Follow-up:** vscode-cql#94 should follow the same rules (no local-repository lookup, `settings.xml`
  for mirrors and credentials only), so both tools behave the same on restricted networks.

## 5. Agent Directives

When changing jar or Java resolution, future AI agents **MUST** follow these rules:

* **MUST NOT** add the local Maven repository (`~/.m2/repository` or `<localRepository>`) as a jar
  source without a new ADR that supersedes this one.
* **MUST NOT** download, or set as the default, a `-SNAPSHOT` LS version. SNAPSHOTs are only
  supported through `CQL_LS_JAR_PATH`.
* **MUST NOT** run a jar in place from a VS Code extension folder. Copy it into the cache first.
* **MUST NOT** resolve Java or the jar before the MCP transport has connected.
* **MUST NOT** log credentials, `Authorization` headers, or URLs that contain a username or password.
* **MUST** keep Maven Central as the last download source, and try a configured repo or mirror
  before it.
* **MUST** check SHA-1 and size and write through a temp file before a downloaded jar goes into the
  cache.
* **MUST** route all download traffic through the `EnvHttpProxyAgent` dispatcher.
* **MUST** cover any path-handling change with tests for macOS/Linux (`/…`), Windows backslash
  (`C:\…`) and Windows forward slash (`C:/…`) paths.
