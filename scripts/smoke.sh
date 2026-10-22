#!/usr/bin/env bash
# Smoke-test the mcp-cql-debug MCP server. Drives stdio JSON-RPC NDJSON
# requests against the canonical entry dist/src/index.js (per
# package.json:bin). Output is captured at /tmp/mcp-smoke.stdout and
# /tmp/mcp-smoke.stderr.
#
# Usage:
#   scripts/smoke.sh <mcp_dir> <workspace_dir> <jar_path>
set -e
MCP_DIR="$1"
WORKSPACE="$2"
JAR="$3"

(
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}'
  sleep 2
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  sleep 1
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
  sleep 2
  echo "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"cql_test_run_file\",\"arguments\":{\"cqlFile\":\"$WORKSPACE/test/fixtures/test-pipeline/CMSDemo/CMSDemo.cql\",\"contextValues\":[\"p1\",\"p2\"],\"suiteName\":\"SmokeTest\"}}}"
  sleep 5
  echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"cql_test_list_runs","arguments":{"suiteName":"SmokeTest"}}}'
  sleep 2
  echo '{"jsonrpc":"2.0","id":99,"method":"shutdown"}'
  sleep 1
) | CQL_LS_JAR_PATH="$JAR" CQL_DEBUG_MCP_WORKSPACE="$WORKSPACE" CQL_DEBUG_MCP_LOG_FILE=/tmp/mcp-smoke.log \
    node "$MCP_DIR/dist/src/index.js" \
    > /tmp/mcp-smoke.stdout 2> /tmp/mcp-smoke.stderr
