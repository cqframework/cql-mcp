import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const REQUIRED_JDK_VERSION = 17;

export interface JavaRuntime {
  javaPath: string;
  version: number;
}

export function javaExecutableName(): string {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

export function collectJavaCandidates(javaHome?: string): string[] {
  const exe = javaExecutableName();
  const candidates: string[] = [];
  const home = javaHome ?? process.env.JAVA_HOME;
  if (home) {
    candidates.push(path.join(home, 'bin', exe));
  }
  candidates.push(exe);
  return candidates;
}

export function resolveJavaBinary(bin: string, pathEnv?: string): string | null {
  // Host-native (ADR-0003): path.basename understands both separators on Windows, only '/' on POSIX.
  const isPathForm = path.basename(bin) !== bin;
  if (isPathForm) {
    return fs.existsSync(bin) ? path.resolve(bin) : null;
  }
  return whichInPath(bin, pathEnv ?? process.env.PATH);
}

export function whichInPath(bin: string, pathEnv: string | undefined): string | null {
  if (!pathEnv) {
    return null;
  }
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function readJavaMajorVersion(javaBinary: string): number | null {
  const res = spawnSync(javaBinary, ['-version'], { encoding: 'utf8' });
  if (res.error) {
    return null;
  }
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  return parseJavaMajorVersion(output);
}

export function parseJavaMajorVersion(versionOutput: string): number | null {
  const match = versionOutput.match(/(?:openjdk\s+version|java\s+version|version)\s*"(\d+)(?:\.(\d+))?/i);
  if (!match) {
    return null;
  }
  const major = parseInt(match[1], 10);
  if (major === 1 && match[2] !== undefined) {
    return parseInt(match[2], 10);
  }
  return major;
}

export function findJavaRuntime(javaHomeOverride?: string): JavaRuntime | null {
  for (const candidate of collectJavaCandidates(javaHomeOverride)) {
    const resolved = resolveJavaBinary(candidate);
    if (!resolved) {
      continue;
    }
    const version = readJavaMajorVersion(resolved);
    if (version !== null && version >= REQUIRED_JDK_VERSION) {
      return { javaPath: resolved, version };
    }
  }
  return null;
}