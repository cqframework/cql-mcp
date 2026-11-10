// Drives the layer 3 restricted-network E2E: packs the build, seeds the mirror, starts the compose
// network, runs scenarios A, B, C1, C2 and D in the client container, and checks assertion 4 (proxy
// logs) after each. Usage: node orchestrate.mjs [--only A,C1] [--skip-b]
//
// Env: E2E_LS_JAR (use this jar instead of the cache/Central), CQL_LS_VERSION.
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const work = path.join(here, '.work');
const compose = ['compose', '-f', path.join(here, 'docker-compose.yml')];

const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1].split(',') : null;
const skipB = args.includes('--skip-b') || process.env.E2E_SKIP_B === '1';

function sh(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  return r;
}
function must(cmd, argv, opts = {}) {
  const r = sh(cmd, argv, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} exited ${r.status}`);
}
const dc = (argv, opts) => sh('docker', [...compose, ...argv], opts);

if (sh('docker', ['info']).status !== 0) {
  console.error('Docker daemon is not reachable. Start Docker and re-run.');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const lsVersion =
  process.env.CQL_LS_VERSION ?? require(path.join(root, 'dist', 'src', 'jvm', 'jarInstaller.js')).DEFAULT_CQL_LS_VERSION;
const artifact = `org/opencds/cqf/cql/ls/cql-ls-server/${lsVersion}/cql-ls-server-${lsVersion}.jar`;

async function ensureJar() {
  const cacheDir = path.join(work, 'jar-cache');
  const cached = path.join(cacheDir, `cql-ls-server-${lsVersion}.jar`);
  if (process.env.E2E_LS_JAR) return process.env.E2E_LS_JAR;
  if (fs.existsSync(cached)) return cached;
  // Seeding happens on the host, before any scenario runs; scenarios themselves stay offline
  // except B.
  const url = `https://repo1.maven.org/maven2/${artifact}`;
  console.log(`downloading ${url}`);
  const jar = Buffer.from(await (await fetch(url)).arrayBuffer());
  const sha1 = (await (await fetch(`${url}.sha1`)).text()).trim().split(/\s+/)[0];
  if (crypto.createHash('sha1').update(jar).digest('hex') !== sha1) throw new Error('SHA-1 mismatch for the downloaded LS jar');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cached, jar);
  return cached;
}

const secret = () => crypto.randomBytes(12).toString('hex');
const mirrorToken = secret();
const proxyUser = 'e2euser';
const proxyPassword = secret();
let exitCode = 1;
const summary = [];

try {
  fs.mkdirSync(path.join(work, 'pkg'), { recursive: true });
  // Pack the current build exactly as it would be published.
  const packed = sh('npm', ['pack', '--json', '--pack-destination', path.join(work, 'pkg')], { cwd: root });
  if (packed.status !== 0) throw new Error(`npm pack failed:\n${packed.stderr}`);
  const tgz = JSON.parse(packed.stdout)[0].filename;
  fs.renameSync(path.join(work, 'pkg', tgz), path.join(work, 'pkg', 'cql-mcp.tgz'));

  const jar = await ensureJar();
  const seedDir = path.join(work, 'seed');
  fs.rmSync(seedDir, { recursive: true, force: true });
  const seeded = path.join(seedDir, artifact);
  fs.mkdirSync(path.dirname(seeded), { recursive: true });
  fs.copyFileSync(jar, seeded);
  const hex = crypto.createHash('sha1').update(fs.readFileSync(seeded)).digest('hex');
  fs.writeFileSync(`${seeded}.sha1`, hex);

  const passwd = path.join(work, 'passwd');
  // squid's basic_ncsa_auth in this image accepts apr1 (MD5) hashes but not {SHA}.
  const hash = sh('openssl', ['passwd', '-apr1', '-stdin'], { input: proxyPassword });
  if (hash.status !== 0) throw new Error(`openssl passwd failed: ${hash.stderr}`);
  fs.writeFileSync(passwd, `${proxyUser}:${hash.stdout.trim()}\n`);

  process.env.E2E_MIRROR_TOKEN = mirrorToken;
  process.env.E2E_PROXY_USER = proxyUser;
  process.env.E2E_PROXY_PASSWORD = proxyPassword;
  process.env.E2E_SEED_DIR = seedDir;
  process.env.E2E_PASSWD_FILE = passwd;
  process.env.E2E_LS_VERSION = lsVersion;

  must('docker', [...compose, 'up', '-d', '--build', '--wait', 'mirror', 'proxy', 'tlsproxy']);
  must('docker', [...compose, 'build', 'client']);

  const squidLog = () => dc(['exec', '-T', 'proxy', 'cat', '/var/log/squid/access.log']).stdout.split('\n').filter(Boolean);
  const mitmLog = () => dc(['exec', '-T', 'tlsproxy', 'cat', '/logs/mitm.log']).stdout.split('\n');
  const clear = () => {
    dc(['exec', '-T', 'proxy', 'sh', '-c', ': > /var/log/squid/access.log']);
    dc(['exec', '-T', 'tlsproxy', 'sh', '-c', ': > /logs/mitm.log']);
  };

  // squid: [] = no entries; 'central' = only authenticated CONNECTs to repo1.maven.org:443.
  // mitm: markers expected (min) from the addon.
  const plan = [
    { id: 'A', squid: 'none', mitm: 0 },
    { id: 'B', squid: 'central', mitm: 0 },
    { id: 'C1', squid: 'none', mitm: 0 },
    { id: 'C2', squid: 'none', mitm: 2 },
    { id: 'D', squid: 'none', mitm: 0 },
  ].filter((s) => (only ? only.includes(s.id) : !(skipB && s.id === 'B')));

  for (const s of plan) {
    console.log(`\n===== scenario ${s.id} =====`);
    clear();
    const r = sh('docker', [...compose, 'run', '--rm', '-T', 'client', 'node', '/e2e/run.mjs', s.id], { stdio: 'inherit', timeout: 20 * 60_000 });
    const problems = [];
    if (r.status !== 0) problems.push(`run.mjs exited ${r.status}`);

    const sq = squidLog();
    if (s.squid === 'none' && sq.length) problems.push(`4. squid log should be empty, has ${sq.length} entries`);
    if (s.squid === 'central') {
      const bad = sq.filter((l) => !/CONNECT repo1\.maven\.org:443/.test(l) || !l.includes(proxyUser));
      if (!sq.length) problems.push('4. squid log has no entries; the proxy was bypassed');
      if (bad.length) problems.push(`4. squid saw requests other than authenticated CONNECT repo1.maven.org:443: ${bad[0]}`);
    }
    const markers = mitmLog().filter((l) => l.includes('E2E-PROXIED')).length;
    const blocked = mitmLog().filter((l) => l.includes('E2E-BLOCKED')).length;
    if (s.mitm === 0 && markers) problems.push(`4. tlsproxy should be unused, proxied ${markers}`);
    if (s.mitm > 0 && markers < s.mitm) problems.push(`4. tlsproxy proxied ${markers} requests, expected >= ${s.mitm}`);
    if (blocked) problems.push(`4. tlsproxy blocked ${blocked} unexpected requests`);
    for (const p of problems) console.log(`FAIL  ${p}`);
    if (!problems.length) console.log(`PASS  4. proxy logs as expected (squid ${sq.length}, tlsproxy ${markers})`);
    summary.push({ id: s.id, ok: problems.length === 0 });
  }
  exitCode = summary.every((s) => s.ok) ? 0 : 1;
} catch (err) {
  console.error(err);
} finally {
  if (exitCode !== 0) {
    console.log('\n--- mirror log (tail) ---');
    dc(['logs', '--tail', '40', 'mirror'], { stdio: 'inherit' });
  }
  dc(['down', '-v', '--remove-orphans'], { stdio: 'inherit' });
  console.log('\nsummary:', summary.map((s) => `${s.id}=${s.ok ? 'PASS' : 'FAIL'}`).join(' ') || 'nothing ran');
}
process.exit(exitCode);
