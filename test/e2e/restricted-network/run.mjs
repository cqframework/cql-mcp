// MCP stdio client for the restricted-network E2E (layer 3). Runs INSIDE the client container:
//   node /e2e/run.mjs <A|B|C1|C2|D>
// It spawns the globally installed `cql-mcp` with a scenario-specific environment and an empty HOME,
// then checks assertions 1, 2, 3 and 5 of the plan. Assertion 4 (proxy logs) needs the proxy
// containers' logs, so orchestrate.mjs checks it after each run.
//
// TODO(cql-language-server#158): add a fake FHIR package registry scenario once the LS honours
// proxy settings and mirror-only package resolution (ADR-0002 scope). Not covered here on purpose.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

if (process.env.E2E_IN_CONTAINER !== '1') {
  console.error('run.mjs only runs inside the e2e client container (it writes settings.xml under HOME).');
  process.exit(2);
}

const scenario = process.argv[2];
const need = (n) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is not set`);
  return v;
};
const TOKEN = need('E2E_MIRROR_TOKEN');
const PROXY_USER = need('E2E_PROXY_USER');
const PROXY_PASSWORD = need('E2E_PROXY_PASSWORD');
const LS_VERSION = need('E2E_LS_VERSION');
const MIRROR = 'http://mirror:8080/releases/';
const JAR_PATH = `org/opencds/cqf/cql/ls/cql-ls-server/${LS_VERSION}/cql-ls-server-${LS_VERSION}.jar`;

const SCENARIOS = {
  // Mirror only: settings.xml mirrorOf * + server token; no proxy.
  A: { settings: true, env: {}, outcome: 'success', via: 'mirror' },
  // Central through squid (Basic auth). The only scenario that reaches the real Maven Central.
  B: {
    settings: false,
    env: { HTTPS_PROXY: `http://${PROXY_USER}:${PROXY_PASSWORD}@proxy:3128`, HTTP_PROXY: `http://${PROXY_USER}:${PROXY_PASSWORD}@proxy:3128` },
    outcome: 'success',
    via: 'repo1.maven.org',
  },
  // TLS interception without the corporate CA: a clear TLS error.
  C1: { settings: false, env: { HTTPS_PROXY: 'http://tlsproxy:8080' }, outcome: 'failure', errorPattern: /certificate|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i },
  // The same with the CA: success.
  C2: {
    settings: false,
    env: { HTTPS_PROXY: 'http://tlsproxy:8080', NODE_EXTRA_CA_CERTS: '/certs/mitmproxy-ca-cert.pem' },
    outcome: 'success',
    via: 'repo1.maven.org',
  },
  // Everything blocked: one aggregated error, server stays up.
  D: { settings: false, env: { CQL_LS_DOWNLOAD_TIMEOUT_MS: '10000' }, outcome: 'failure', errorPattern: /repo1\.maven\.org/ },
};
const sc = SCENARIOS[scenario];
if (!sc) {
  console.error(`unknown scenario ${scenario}; expected one of ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}

// The SDK ships inside the globally installed package, not next to this script.
const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const pkgDir = path.join(globalRoot, '@cqframework', 'cql-mcp');
const req = createRequire(path.join(pkgDir, 'package.json'));
const { Client } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function waitForMirror() {
  const url = `http://mirror:8080/releases/${JAR_PATH}.sha1`;
  const basic = `Basic ${Buffer.from(`e2e:${TOKEN}`).toString('base64')}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const withAuth = await fetch(url, { headers: { authorization: basic } });
      if (withAuth.status === 200) {
        const noAuth = await fetch(url);
        check('preflight: mirror is private (no token is refused)', noAuth.status === 401 || noAuth.status === 403, `status ${noAuth.status}`);
        return;
      }
      if (Date.now() > deadline) throw new Error(`mirror answered ${withAuth.status} for the seeded .sha1`);
    } catch (err) {
      if (Date.now() > deadline) throw err;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-home-'));
const workspace = path.join(home, 'work');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'E2E.cql'), "library E2E version '1.0.0'\n\ndefine X: 1 + 1\n");
const logFile = path.join(home, 'cql-mcp.log');
if (sc.settings) {
  fs.mkdirSync(path.join(home, '.m2'));
  fs.writeFileSync(
    path.join(home, '.m2', 'settings.xml'),
    `<settings>
  <mirrors><mirror><id>corp</id><mirrorOf>*</mirrorOf><url>${MIRROR}</url></mirror></mirrors>
  <servers><server><id>corp</id><username>e2e</username><password>${TOKEN}</password></server></servers>
</settings>
`,
  );
}

let client;
let transport;
let stderr = '';
const toolText = [];
try {
  if (scenario === 'A' || scenario === 'C2') await waitForMirror();

  transport = new StdioClientTransport({
    command: 'cql-mcp',
    env: {
      HOME: home,
      CQL_MCP_WORKSPACE: workspace,
      CQL_MCP_LOG_FILE: logFile,
      CQL_MCP_LOG_LEVEL: 'debug',
      ...sc.env,
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (d) => {
    stderr += d.toString('utf8');
  });
  client = new Client({ name: 'e2e-restricted-network', version: '0' });

  // 1. initialize is fast even with an empty cache.
  const t0 = Date.now();
  await client.connect(transport);
  const initMs = Date.now() - t0;
  check('1. initialize < 2 s with an empty cache', initMs < 2000, `${initMs} ms`);

  const call = async (name, args = {}) => {
    let r;
    try {
      r = await client.callTool({ name, arguments: args });
    } catch (err) {
      // Today a failing tool surfaces as a JSON-RPC error; Phase 3 turns it into isError. Accept both.
      const text = String(err?.message ?? err);
      toolText.push(text);
      return { isError: true, text };
    }
    const text = r.content?.map((c) => c.text ?? '').join('') ?? '';
    toolText.push(text);
    return { isError: r.isError === true, text };
  };
  const status = async () => JSON.parse((await call('cql_get_status')).text);

  // 2. Watch the download state while it runs.
  const observed = [];
  const deadline = Date.now() + (sc.outcome === 'success' ? 600_000 : 60_000);
  let s;
  for (;;) {
    s = await status();
    observed.push(s.runtime);
    // Fail fast: a failed resolution will not recover by waiting (and polling must not hammer it).
    if (s.runtime.state === 'ready' || s.runtime.state === 'failed') break;
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const sawJarPhase = observed.some((r) => r.state === 'resolving' && (r.phase === 'jar' || r.download));
  const urls = observed.filter((r) => r.download).map((r) => new URL(r.download.url).host);

  if (sc.outcome === 'success') {
    check('2a. status reported resolving/jar (download in progress) before ready', sawJarPhase);
    check(`2b. observed download host is ${sc.via}`, urls.length > 0 && urls.every((h) => h.startsWith(sc.via)), urls[0] ?? 'no progress seen');
    check('2c. runtime ready', s.runtime.state === 'ready', s.runtime.error ?? '');
    check('2d. jarSource and LS version reported', s.jarSource === 'download' && !!s.languageServerVersion && String(s.jarPath).includes(LS_VERSION), `${s.jarSource} / ${s.languageServerVersion}`);
    // 3. cql_execute on a 3-line library returns 2.
    const ex = await call('cql_execute', { cqlFile: path.join(workspace, 'E2E.cql') });
    let value;
    try {
      const body = JSON.parse(ex.text);
      value = body.results?.flatMap((r) => r.expressions ?? []).find((e) => e.name === 'X')?.value;
    } catch {
      /* reported below */
    }
    check('3. cql_execute returns X = 2', !ex.isError && String(value).trim() === '2', ex.isError ? ex.text.slice(0, 200) : `X=${value}`);
  } else {
    check('2a. runtime failed with an error', s.runtime.state === 'failed' && !!s.runtime.error, s.runtime.state);
    check(`2b. error matches ${sc.errorPattern}`, sc.errorPattern.test(s.runtime.error ?? ''), (s.runtime.error ?? '').split('\n')[0].slice(0, 160));
    check('2c. one aggregated error (single failure, no retry loop)', (s.runtime.error ?? '').length > 0 && !/\n\n\n/.test(s.runtime.error));
    // The server must stay up and keep answering.
    const again = await status();
    check('2d. server still answers cql_get_status after the failure', again.runtime.state === 'failed');
    const ex = await call('cql_execute', { cqlFile: path.join(workspace, 'E2E.cql') });
    check('3. cql_execute fails cleanly (isError, no crash)', ex.isError, ex.text.slice(0, 120));
  }
} catch (err) {
  check('run completed without an unexpected exception', false, String(err?.stack ?? err));
} finally {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
}

// 5. No secrets in the log file, stderr or any tool output.
const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
const haystack = { 'log file': logText, stderr, 'tool output': toolText.join('\n') };
const secrets = { 'mirror token': TOKEN, 'proxy password': PROXY_PASSWORD };
for (const [what, text] of Object.entries(haystack)) {
  for (const [label, secret] of Object.entries(secrets)) {
    check(`5. ${what} has no ${label}`, !text.includes(secret));
  }
}
check('5. log file was written (leak check is meaningful)', logText.length > 0);

fs.rmSync(home, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\nscenario ${scenario}: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
