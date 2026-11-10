import { log } from '../log.js';

const warned = new Set<string>();

/** Test-only: forget which legacy names have already produced a deprecation warning. */
export function resetEnvWarnings(): void {
  warned.clear();
}

/** Like readEnv, but never logs. Use before the logger is configured. */
export function peekEnv(name: string, legacyName?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[name] ?? (legacyName ? env[legacyName] : undefined);
}

/**
 * Reads `name`, falling back to the deprecated `legacyName`. The first use of a given legacy
 * name logs one deprecation warning per process.
 */
export function readEnv(name: string, legacyName?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name];
  if (value !== undefined) {
    return value;
  }
  if (legacyName && env[legacyName] !== undefined) {
    if (!warned.has(legacyName)) {
      warned.add(legacyName);
      log.warn(`Environment variable ${legacyName} is deprecated; use ${name} instead.`);
    }
    return env[legacyName];
  }
  return undefined;
}
