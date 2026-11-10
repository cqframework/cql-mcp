#!/usr/bin/env bash
# Smoke-test the cql-mcp MCP server. Drives stdio JSON-RPC NDJSON requests against the canonical
# entry dist/src/index.js (per package.json:bin), then checks the responses and exits non-zero on
# any failure. Output is captured at /tmp/mcp-smoke.stdout and /tmp/mcp-smoke.stderr.
#
# Usage:
#   scripts/smoke.sh <mcp_dir> <workspace_dir> <jar_path>
set -e
MCP_DIR="$1"
WORKSPACE="$2"
JAR="$3"
OUT=/tmp/mcp-smoke.stdout
ERR=/tmp/mcp-smoke.stderr
: > "$OUT"

# Wait until the response with the given JSON-RPC id appears on stdout, or give up after N seconds.
wait_for_id() {
  local id="$1" timeout="$2" waited=0
  while ! grep -q "\"id\":$id[,}]" "$OUT"; do
    sleep 0.2
    waited=$((waited + 1))
    if [ "$waited" -ge $((timeout * 5)) ]; then
      return 0 # the check below reports the missing response
    fi
  done
}

(
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}'
  wait_for_id 1 30
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  wait_for_id 2 30
  # The first tool call includes Java and jar resolution plus the language-server start (ADR-0001).
  echo "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"cql_test_run_file\",\"arguments\":{\"cqlFile\":\"$WORKSPACE/test/fixtures/test-pipeline/CMSDemo/CMSDemo.cql\",\"contextValues\":[\"p1\",\"p2\"],\"suiteName\":\"SmokeTest\"}}}"
  wait_for_id 3 120
  echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"cql_test_list_runs","arguments":{"suiteName":"SmokeTest"}}}'
  wait_for_id 4 30
  # Leaving the subshell closes the server's stdin, which is how MCP clients disconnect.
) | CQL_LS_JAR_PATH="$JAR" CQL_MCP_WORKSPACE="$WORKSPACE" CQL_MCP_LOG_FILE=/tmp/mcp-smoke.log \
    node "$MCP_DIR/dist/src/index.js" \
    > "$OUT" 2> "$ERR"

node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
const byId = new Map();
for (const l of lines) {
  try { const m = JSON.parse(l); if (m.id !== undefined) byId.set(m.id, m); } catch { /* not JSON-RPC */ }
}
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` (${detail})`}`);
  if (!ok) failures.push(name);
};
for (const id of [1, 2, 3, 4]) {
  const m = byId.get(id);
  check(`response for id ${id}`, !!m);
  if (m) check(`id ${id} is not a JSON-RPC error`, !m.error, JSON.stringify(m.error));
}
const init = byId.get(1)?.result;
check("serverInfo.name is cql-mcp", init?.serverInfo?.name === "cql-mcp", init?.serverInfo?.name);
const tools = byId.get(2)?.result?.tools ?? [];
check("tools/list has 19 tools", tools.length === 19, String(tools.length));
const bare = tools.filter((t) => !t.annotations).map((t) => t.name);
check("every tool has annotations", tools.length > 0 && bare.length === 0, bare.join(","));
for (const id of [3, 4]) {
  const r = byId.get(id)?.result;
  check(`id ${id} is not an isError result`, !!r && r.isError !== true, r?.content?.[0]?.text?.slice(0, 200));
}
const unexpected = [...byId.values()].filter((m) => m.error).map((m) => m.error.code);
check("no -32601 or other JSON-RPC errors anywhere", unexpected.length === 0, unexpected.join(","));
console.log(failures.length === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failures.length} failed)`);
process.exit(failures.length === 0 ? 0 : 1);
' "$OUT"
