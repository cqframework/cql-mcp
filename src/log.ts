import * as fs from 'node:fs';
import * as path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: number = LEVEL_WEIGHT.info;
let stream: fs.WriteStream | null = null;

export interface LogConfig {
  level?: LogLevel;
  file?: string;
}

export function configureLog(config?: LogConfig): void {
  if (config?.level) {
    minLevel = LEVEL_WEIGHT[config.level];
  }
  if (config?.file) {
    stream?.end();
    stream = fs.createWriteStream(path.resolve(config.file), { flags: 'a' });
  }
}

function format(level: LogLevel, message: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  const metaPart = meta === undefined ? '' : ' ' + safeJson(meta);
  return `${ts} [${level}] ${message}${metaPart}\n`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVEL_WEIGHT[level] < minLevel) {
    return;
  }
  const line = format(level, message, meta);
  process.stderr.write(line);
  stream?.write(line);
}

export const log = {
  debug: (message: string, meta?: unknown) => write('debug', message, meta),
  info: (message: string, meta?: unknown) => write('info', message, meta),
  warn: (message: string, meta?: unknown) => write('warn', message, meta),
  error: (message: string, meta?: unknown) => write('error', message, meta),
};

export function tailOf(lines: string[], max: number): string[] {
  return lines.slice(Math.max(0, lines.length - max));
}