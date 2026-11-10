/**
 * Per-platform test blocks (ADR-0003 §2.4). Each CI runner tests its own native path forms:
 * hard-coded `C:\…` or `/…` paths belong inside onWindows(…) or onPosix(…), and every block needs a
 * counterpart for the other platform. The block is skipped (visibly) on the other host.
 */
export const isWin = process.platform === 'win32';

export function onWindows(title: string, fn: (this: Mocha.Suite) => void): void {
  (isWin ? describe : describe.skip)(`[windows] ${title}`, fn);
}

export function onPosix(title: string, fn: (this: Mocha.Suite) => void): void {
  (isWin ? describe.skip : describe)(`[posix] ${title}`, fn);
}
