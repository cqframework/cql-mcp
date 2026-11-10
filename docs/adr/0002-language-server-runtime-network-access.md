---
title: "ADR-0002: Language Server Runtime Network Access (FHIR Packages, Proxies, TLS)"
status: "Proposed"
date: "2026-11-10"
tags: ["dependencies", "fhir-packages", "proxy", "tls", "jvm", "restricted-networks"]
---

## 1. Context

ADR-0001 covers how cql-mcp gets Java and the `cql-ls-server` jar. Once it's running, the
language server makes **its own** network requests. These come from inside the JVM, so none of
cql-mcp's Node-side network handling applies to them.

**What the LS fetches.** When an IG declares FHIR package dependencies (QI-Core, US Core, CRMI
and so on), `IgContextManager.readContext` (cql-language-server) builds a HAPI
`FilesystemPackageCacheManager` with the default builder. Missing packages are downloaded into
`~/.fhir/packages`. If that fails, the LS logs a warning, skips the dependencies that aren't
cached, and carries on. The failure surfaces later as unresolved libraries, profiles or value
sets, not as a network error.

**How HAPI does it.** These facts were checked in `org.hl7.fhir.utilities` 6.9.12, the version
inside `cql-ls-server-5.0.0.jar`:

| Concern | Behaviour |
| --- | --- |
| Default registries | `https://packages2.fhir.org/packages` (primary), then `https://packages.fhir.org`. `https://build.fhir.org` is used for `current` CI builds. |
| Configuration file | `fhir-settings.json`. The path comes from the `-Dfhir.settings.path` system property, otherwise `~/.fhir/fhir-settings.json`. |
| Mirrors | `servers[]` entries with `type: "fhir-package"` or `"npm-package"` are tried **before** the defaults. They can use `authenticationType` `basic` (username and password), `token` or `apikey`. Setting `ignoreDefaultPackageServers: true` removes the public registries. |
| Fallback past the mirror | **Reproduced 2026-11-10.** If no configured server supplies the package, for **any** failure (404, 401, connection refused, or a failed tarball download), HAPI still contacts `build.fhir.org` (`CIBuildClient`, then `fetchTheOldWay`, `FilesystemPackageCacheManager.java:840`), even with `ignoreDefaultPackageServers: true`. That setting only filters HAPI's default *registry* list. The fallback is logged at DEBUG, plus a WARN from `PackageClient` for the version-listing call. Nothing at INFO or above says it's going to a public site. |
| Mirror API (`npm-package`) | `GET <url>/<id>/<version>` (`Accept: application/json`) must return JSON with an absolute `dist.tarball` URL. HAPI then fetches `GET <dist.tarball>`. If that fails, it retries with `<major>.<minor>.x`, via `GET <url>/<id>` (a `versions` map). A `fhir-package` server serves the tarball directly at `<url>/<id>/<version>`. |
| Mirror auth | `token`: `Authorization: Bearer <token>`. `basic`: `Authorization: Basic …`. `apikey`: `Api-Key: <key>`. **Credentials are only sent to URLs with the same protocol, host and port whose path starts with the server `url`'s path** (`ManagedWebAccessUtils.urlMatchesOrigin`). A tarball served from elsewhere, for example `/tarballs/…` when `url` is `…/packages`, or a CDN, gets **no** auth header, fails with 401, and triggers the public fallback. |
| Offline | `prohibitNetworkAccess: true` blocks all HTTP, so only `~/.fhir/packages` is used. It also blocks the mirror, so it can't be combined with a mirror-only setup. |
| HTTP client | Package downloads go through `ManagedWebAccessor`, then `SimpleHTTPClient`, which uses `java.net.URL.openConnection()` (plain `HttpURLConnection`). |
| Proxy | `HttpURLConnection` follows the JVM's `https.proxyHost`/`https.proxyPort`, `http.proxyHost`/`http.proxyPort`, `http.nonProxyHosts` and `java.net.useSystemProxies` settings. It **ignores** `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`. HAPI only reads `http.proxyUser`/`http.proxyPassword` in its OkHttp-based FHIR client, **not** on the package download path, so proxy credentials need a `java.net.Authenticator` that nothing installs today. The JDK also blocks Basic auth on HTTPS proxy tunnels by default (`jdk.http.auth.tunneling.disabledSchemes`). |
| TLS | The JVM's default truststore. `NODE_EXTRA_CA_CERTS` has no effect. `fhir-settings.json` has a `certificateSources` field, but its effect on this path hasn't been checked. |

**Reported in the field, and reproduced.** [vscode-cql#106](https://github.com/cqframework/vscode-cql/issues/106)
(open, against 0.7.7): a `fhir-settings.json` mirror with `ignoreDefaultPackageServers: true` and
token auth is ignored, and packages still come from the public registry. Reproduced on 2026-11-10
against LS 5.0.0 (utilities 6.9.12), both by calling HAPI directly and through the LS with
cql-mcp. There are two triggers: (1) the mirror doesn't host a package the LS needs. The LS
always loads `hl7.fhir.r4.core` first, so a registry with only private packages hits this
straight away. (2) The mirror's tarball URL is outside the configured `url` path, so the token
isn't sent. In the LS run, `cql_validate` then returned **valid, with no diagnostics**: the LS
skipped the failed dependencies with a single WARN in its own log. The reproduction scripts are
the basis for the §6 regression test.

**Who it affects.** vscode-cql starts the same jar and has the same gap. VS Code's proxy settings
only patch Node inside the extension host, not the JVM it starts.

## 2. Decision

This is **proposed**. §2.3 needs a change in cql-language-server, which our team owns.

### 2.1 cql-mcp passes Node-style proxy variables to the JVM

When it starts the LS (`CqlLsProcess.buildArgs`, `src/jvm/cqlLsProcess.ts`), cql-mcp converts the
environment variables cql-mcp itself honours (ADR-0001 §2.5) into JVM system properties:

| Env var (upper or lower case) | JVM properties |
| --- | --- |
| `HTTPS_PROXY` | `-Dhttps.proxyHost`, `-Dhttps.proxyPort` (default 443 or 80 by scheme) |
| `HTTP_PROXY` | `-Dhttp.proxyHost`, `-Dhttp.proxyPort` |
| `NO_PROXY` | `-Dhttp.nonProxyHosts`. Commas become `\|`, `.example.com` becomes `*.example.com`, and `*` disables the proxy |
| userinfo in either URL (`user:pass@`) | `-Dhttp.proxyUser`, `-Dhttp.proxyPassword`, plus `-Djdk.http.auth.tunneling.disabledSchemes=` (empty), which allows Basic auth on HTTPS tunnels |

A proxy property the user has already set in `CQL_LS_JAVA_OPTS` (§2.4) is never overridden.
Credentials are passed as system properties, never logged, and redacted from the command line
cql-mcp writes to its debug log.

### 2.2 FHIR registry mirrors and offline use go through HAPI's own settings file

cql-mcp and the LS add **no** settings of their own for FHIR registries. Users configure
mirrors, credentials and offline mode in `~/.fhir/fhir-settings.json`. **Caveat:** given HAPI's
fallback past the mirror (§1), this gives *mirror-first*, not *mirror-only*, behaviour until open
question 4 is resolved. Mirrors, credentials and offline mode live in the file HAPI's IG
Publisher and validator already use. That way one file serves every HAPI-based tool. cql-mcp adds
one optional setting, `CQL_LS_FHIR_SETTINGS`, which it passes as `-Dfhir.settings.path`, for
users who want a separate file.

### 2.3 The LS installs a proxy `Authenticator` (cql-language-server change)

On startup, the LS installs a `java.net.Authenticator` that answers `RequestorType.PROXY`
challenges from `http.proxyUser`/`http.proxyPassword`, and only when those are set. Without it,
§2.1's credentials reach the FHIR client but not package downloads. It's a small change to
`Main.kt` and can ship in LS 5.1.

### 2.4 A generic JVM options passthrough

`CQL_LS_JAVA_OPTS` is split on whitespace, with simple quoting, and added before `-jar`. It's the
escape hatch for anything that doesn't fit §2.1–2.3:

- a corporate truststore (`-Djavax.net.ssl.trustStore=…`, `-Djavax.net.ssl.trustStorePassword=…`)
- `-Djava.net.useSystemProxies=true`
- heap size, which replaces the hard-coded `-Xmx4g` if present

### 2.5 Failures must be visible

When package loading fails, the LS warning must reach the agent, so it doesn't just see missing
libraries. cql-mcp reports the last package-loading failure in `cql_get_status`, and
`cql_validate` includes a hint when an unresolved include matches a declared IG dependency. The
exact mechanism will be designed with Phase 2b.

## 3. Alternatives Considered

* **Do nothing and document `-D` flags.** **Rejected.** cql-mcp has no way to pass them today.
  And a user who has set `HTTPS_PROXY` reasonably expects it to apply to the whole tool, not
  just the jar download.
* **`JAVA_TOOL_OPTIONS` only.** **Rejected as the main mechanism.** It applies to every JVM on
  the machine, prints a banner on stderr, and is easy to get wrong. It still works if users set
  it themselves.
* **Our own registry-mirror settings in the LS.** **Rejected.** That would duplicate
  `fhir-settings.json`, which HAPI already reads and which FHIR tooling users may already have.
* **Convert `NODE_EXTRA_CA_CERTS` into a JVM truststore automatically.** **Deferred.** It means
  generating a PKCS12 truststore at startup, merged with the JDK's `cacerts`. Reconsider if TLS
  interception turns out to be common among users. Until then, it's a documented
  `CQL_LS_JAVA_OPTS` recipe.
* **Pre-bundle common FHIR packages in the jar or npm package.** **Rejected.** IG dependency
  versions differ between projects, and the jar is already about 210 MB.

## 4. Consequences

* **Positive:** One set of proxy variables covers both the jar download and the LS's package
  fetches.
* **Positive:** Registry mirrors and offline use work through a file HAPI users already know,
  with no new code beyond passing `-Dfhir.settings.path`.
* **Positive:** vscode-cql can reuse the same mapping, from VS Code's `http.proxy` setting to JVM
  properties, so the two tools behave the same.
* **Negative:** Proxy credentials appear as system properties in the JVM command line, which
  `ps` can show to other local users. That's the same exposure as `HTTPS_PROXY` in the
  environment, but more visible. If this matters, later we could pass them over stdin or in a
  temp file the LS reads.
* **Negative:** Proxy auth on package downloads needs an LS change (§2.3), so it only works
  once LS 5.1 is pinned.
* **Negative:** Corporate TLS needs a manual truststore recipe until the deferred alternative is
  built.

## 5. Open Questions (to resolve before Accepted)

1. Does `fhir-settings.json` `certificateSources` affect `SimpleHTTPClient`? If it does, it could
   replace the truststore recipe.
2. Does the LS validation path (`cql_test_validate_resources`, feature branch) fetch from
   `tx.fhir.org` or other terminology servers? If so, those requests need the same handling.
3. Should vscode-cql adopt §2.1/§2.4 in the same release (vscode-cql#94 follow-up)?
4. **vscode-cql#106: mirror-only behaviour.** The cause is now confirmed (see Context). Decide
   between (a) an LS-side guard that skips the fallback when `ignoreDefaultPackageServers` is set,
   for example by pre-resolving through the configured servers with `PackageClient`, and only
   then calling `loadPackage`; (b) an upstream HAPI change, which should also cover sending
   credentials to the tarball host; or (c) documenting it. Either way, §2.5 (making failures
   visible) is needed, because today the user sees a clean validation.

## 6. Testing

This extends ADR-0001 §2.9:

- **Unit tests:** the env-to-JVM mapping, covering upper and lower case, ports by scheme,
  `NO_PROXY` translation, userinfo, the `CQL_LS_JAVA_OPTS` override, and redaction in log
  output.
- **Restricted-network E2E:** add a fake FHIR package registry to the `corp` network, plus a
  test IG that depends on one package from it. Assert three things. Through squid, the package
  arrives in an empty `~/.fhir/packages`. With a `fhir-settings.json` mirror and
  `ignoreDefaultPackageServers`, the public registries are never contacted. With
  `prohibitNetworkAccess`, there's no outbound traffic at all.
- **LS unit test** (cql-language-server): the `Authenticator` answers proxy challenges only, and
  only when credentials are set.

## 7. Agent Directives

* **MUST NOT** add LS-specific settings for FHIR registries. Use `fhir-settings.json`.
* **MUST NOT** override a proxy or truststore property that the user set explicitly in
  `CQL_LS_JAVA_OPTS`.
* **MUST NOT** log proxy credentials or the unredacted JVM command line.
* **MUST** keep cql-mcp's Node-side and JVM-side proxy handling driven by the same
  environment variables.
