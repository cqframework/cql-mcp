import * as path from 'node:path';

/**
 * Expected values for POSIX-form inputs, which mean different things on different hosts: on
 * Windows `/x` is relative to the current drive, so it resolves to `<drive>:\x` and the file URI is
 * `file:///<drive>:/x`. Windows-form inputs (`C:\x`, `C:/x`) are host-independent and don't need
 * these helpers.
 */
export const isWin = process.platform === 'win32';

/** The current drive on a Windows host (e.g. `D:`), or '' elsewhere. */
export const currentDrive: string = isWin ? path.resolve('/').slice(0, 2) : '';

/** The file URI `pathToUri` produces on this host for an absolute POSIX-form path. */
export function hostFileUri(posixAbs: string): string {
  return isWin ? `file:///${currentDrive}${posixAbs}` : `file://${posixAbs}`;
}

/** The path `uriToPath` produces on this host for an absolute POSIX-form path. */
export function hostPath(posixAbs: string): string {
  return isWin ? `${currentDrive}${posixAbs.replace(/\//g, '\\')}` : posixAbs;
}
