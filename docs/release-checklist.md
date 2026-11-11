# Release checklist

Layers 1–3 of the test strategy (unit, network integration and the restricted-network E2E in
`.github/workflows/e2e.yml`) must be green first. This checklist covers only what they can't
simulate faithfully. Tick each item against the release candidate before publishing.

- [ ] **Claude Code.** Run `claude mcp add cql-mcp -- npx -y @cqframework/cql-mcp@<rc>`, or for a
  GitHub-hosted release candidate,
  `claude mcp add cql-mcp -- npx -y --package=<release tarball URL> cql-mcp`. From a real CQL
  project, `/mcp` shows the server connected, and a debug session works: start, breakpoint,
  continue, variables, stop.
- [ ] **Claude Desktop.** Add the same server to `claude_desktop_config.json` with cwd `/`. Check that
  setting `CQL_MCP_WORKSPACE` works, and that the error is clear when it isn't set.
- [ ] **Windows 11 with Defender on.** Do a first-run download, then start a second instance while the
  first is running.
- [ ] **A machine that already has vscode-cql at the same LS version.** `cql_get_status` shows
  `jarSource: vscode-extension` and nothing is downloaded.
- [ ] **A real restricted network, if anyone has one (optional, not a release blocker).** Publish the
  release candidate under the `next` npm dist-tag and ask a volunteer, for example the
  vscode-cql#94 reporter, to try it.
