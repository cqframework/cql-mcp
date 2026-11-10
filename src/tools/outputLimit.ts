import { z } from 'zod';

/** Output bound for tools whose result grows with the input (ADR-0004 §2.4). */
export const MAX_CHARS_DEFAULT = 50_000;
export const MAX_CHARS_MIN = 1_000;

/** The optional `maxChars` argument. The SDK applies the default and enforces the minimum. */
export const maxCharsSchema = z
  .number()
  .int()
  .min(MAX_CHARS_MIN)
  .default(MAX_CHARS_DEFAULT)
  .describe(`Maximum characters of result to return (default ${MAX_CHARS_DEFAULT}, minimum ${MAX_CHARS_MIN}).`);

/** `maxChars` from handler args; direct handler calls (unit tests) may skip the SDK's default. */
export function maxCharsOf(args: Record<string, unknown>): number {
  return typeof args.maxChars === 'number' ? args.maxChars : MAX_CHARS_DEFAULT;
}

export function jsonLength(value: unknown): number {
  return JSON.stringify(value)?.length ?? 4;
}

/** The longest prefix of `items` whose serialized sizes (plus a comma each) fit in `budget`. */
export function fitPrefix<T>(items: T[], budget: number): { kept: T[]; omitted: T[] } {
  let used = 0;
  let n = 0;
  for (const item of items) {
    const size = jsonLength(item) + 1;
    if (used + size > budget) break;
    used += size;
    n += 1;
  }
  return { kept: items.slice(0, n), omitted: items.slice(n) };
}

/** At most this many omitted names are listed; the count is always given. */
export const MAX_LISTED_OMISSIONS = 100;

/**
 * Build a bounded result, shrinking until its serialized length is at most `maxChars`. `build`
 * receives the character budget left for the kept items (the truncation fields' size isn't known
 * until the omitted items are), so the budget is lowered by each overshoot and the build repeated.
 */
export function buildWithin<T>(maxChars: number, initialReserve: number, build: (budget: number) => T): T {
  let reserve = initialReserve;
  let out = build(maxChars - reserve);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const over = jsonLength(out) - maxChars;
    if (over <= 0) break;
    reserve += over + 16;
    out = build(maxChars - reserve);
  }
  return out;
}
