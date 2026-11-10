import * as fs from 'node:fs';
import * as os from 'node:os';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { log } from '../log.js';
import { joinLike } from '../workspace/paths.js';

export interface MavenMirror {
  id: string;
  url: string;
  mirrorOf: string;
}

export interface MavenServer {
  id: string;
  username?: string;
  password?: string;
}

export interface MavenSettings {
  mirrors: MavenMirror[];
  servers: MavenServer[];
  warnings: string[];
}

export interface LoadMavenSettingsOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // keep "1234" as a string (passwords)
  trimValues: true,
  isArray: (name) => name === 'mirror' || name === 'server',
});

/** Locations of the user and global settings files, user first. */
export function mavenSettingsPaths(options: LoadMavenSettingsOptions = {}): { user: string; global?: string } {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const user = env.CQL_LS_MAVEN_SETTINGS || joinLike(homeDir, '.m2', 'settings.xml');
  const mavenHome = env.MAVEN_HOME || env.M2_HOME;
  return { user, global: mavenHome ? joinLike(mavenHome, 'conf', 'settings.xml') : undefined };
}

/**
 * Reads `<mirrors>` and `<servers>` from the user and global Maven settings. `<localRepository>`
 * and `<proxies>` are deliberately ignored (ADR-0001). Never throws: a missing file gives empty
 * settings, malformed XML gives empty settings plus a warning. Warnings are also logged and never
 * contain credential values.
 */
export function loadMavenSettings(options: LoadMavenSettingsOptions = {}): MavenSettings {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const paths = mavenSettingsPaths({ env, homeDir });
  const warnings: string[] = [];

  const user = readSettingsFile(paths.user, homeDir, env, warnings);
  const global = paths.global ? readSettingsFile(paths.global, homeDir, env, warnings) : emptyFile();

  // User settings dominate: their mirrors come first, and an <id> they define replaces the global one.
  const mirrors = mergeById(user.mirrors, global.mirrors);
  const servers = mergeById(user.servers, global.servers);

  for (const w of warnings) {
    log.warn(w);
  }
  return { mirrors, servers, warnings };
}

/**
 * Whether a mirror's `<mirrorOf>` applies to Maven Central. Matches Maven's DefaultMirrorSelector:
 * any `!central` token excludes it whatever the token order; otherwise `central`, `*` and
 * `external:*` (central counts as external) match.
 */
export function mirrorMatchesCentral(mirrorOf: string): boolean {
  const tokens = mirrorOf
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.includes('!central')) {
    return false;
  }
  return tokens.some((t) => t === 'central' || t === '*' || t === 'external:*');
}

/** The first mirror that matches Central, as in Maven. */
export function findCentralMirror(settings: MavenSettings): MavenMirror | undefined {
  return settings.mirrors.find((m) => mirrorMatchesCentral(m.mirrorOf));
}

export function findServer(settings: MavenSettings, id: string): MavenServer | undefined {
  return settings.servers.find((s) => s.id === id);
}

interface SettingsFile {
  mirrors: MavenMirror[];
  servers: MavenServer[];
}

function emptyFile(): SettingsFile {
  return { mirrors: [], servers: [] };
}

function mergeById<T extends { id: string }>(dominant: T[], recessive: T[]): T[] {
  const ids = new Set(dominant.map((x) => x.id));
  return [...dominant, ...recessive.filter((x) => !ids.has(x.id))];
}

function readSettingsFile(file: string, homeDir: string, env: NodeJS.ProcessEnv, warnings: string[]): SettingsFile {
  let xml: string;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') {
      warnings.push(`Could not read Maven settings ${file}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    return emptyFile();
  }
  let doc: any;
  try {
    // The parser alone is lenient (unclosed tags parse), so validate first.
    if (XMLValidator.validate(xml) !== true) {
      throw new Error('invalid XML');
    }
    doc = parser.parse(xml);
  } catch {
    warnings.push(`Ignoring malformed Maven settings ${file}`);
    return emptyFile();
  }
  const settings = doc?.settings;
  if (!settings || typeof settings !== 'object') {
    warnings.push(`Ignoring Maven settings ${file}: no <settings> element`);
    return emptyFile();
  }

  const mirrors: MavenMirror[] = [];
  for (const m of asList(settings.mirrors?.mirror)) {
    const id = text(m.id);
    const mirrorOf = text(m.mirrorOf);
    const rawUrl = text(m.url);
    if (!id || !mirrorOf || !rawUrl) {
      continue;
    }
    const url = expand(rawUrl, homeDir, env);
    if (url === undefined) {
      warnings.push(`Skipping Maven mirror '${id}' in ${file}: its <url> uses an unset placeholder`);
      continue;
    }
    mirrors.push({ id, url, mirrorOf });
  }

  const servers: MavenServer[] = [];
  for (const s of asList(settings.servers?.server)) {
    const id = text(s.id);
    if (!id) {
      continue;
    }
    const server: MavenServer = { id };
    for (const field of ['username', 'password'] as const) {
      const raw = text(s[field]);
      if (raw === undefined) {
        continue;
      }
      const value = expand(raw, homeDir, env);
      if (value === undefined) {
        warnings.push(`Skipping <${field}> of Maven server '${id}' in ${file}: it uses an unset placeholder`);
      } else if (field === 'password' && /^\{.*\}$/.test(value)) {
        warnings.push(
          `Skipping encrypted password of Maven server '${id}' in ${file}: settings-security.xml is not supported`,
        );
      } else {
        server[field] = value;
      }
    }
    servers.push(server);
  }
  return { mirrors, servers };
}

function asList(value: unknown): any[] {
  return Array.isArray(value) ? value.filter((v) => v && typeof v === 'object') : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Expands ${user.home} and ${env.NAME}; returns undefined when a placeholder cannot be resolved. */
function expand(value: string, homeDir: string, env: NodeJS.ProcessEnv): string | undefined {
  let unresolved = false;
  const out = value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    if (name === 'user.home') {
      return homeDir;
    }
    if (name.startsWith('env.')) {
      const v = env[name.slice(4)];
      if (v !== undefined) {
        return v;
      }
    }
    unresolved = true;
    return '';
  });
  return unresolved ? undefined : out;
}
