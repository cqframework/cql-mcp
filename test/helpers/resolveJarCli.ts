/**
 * Tiny wrapper around ensureJar() for tests that need a separate process (NODE_EXTRA_CA_CERTS is
 * only read at process start, and concurrent first runs need real processes). Configuration comes
 * from the environment (CQL_LS_*, CQL_MCP_JAR_DIR, proxies) plus two test-only variables:
 *   CQL_TEST_HOME     home directory for ~/.m2 and ~/.vscode lookups
 *   CQL_TEST_CENTRAL  stand-in for Maven Central
 * Prints one JSON line and sets the exit code; it deliberately does not call process.exit(), so a
 * timer left running would keep the process alive and show up as a hang.
 */
import { ensureJar } from '../../src/jvm/jarInstaller.js';

async function main(): Promise<void> {
  try {
    const result = await ensureJar({
      homeDir: process.env.CQL_TEST_HOME,
      centralRepo: process.env.CQL_TEST_CENTRAL,
    });
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err) }) + '\n');
    process.exitCode = 1;
  }
}

void main();
