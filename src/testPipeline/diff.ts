import type { DiffReport, NoPreviousRunReport, RunCaseResult, RunRecord } from './testCaseModel.js';

/**
 * Pure function. Compares two RunRecord instances by patientId and produces a
 * DiffReport. Cases that appear only in `before` are listed as `removed`;
 * only-in-after are `added`; in both are compared expression-by-expression
 * (and `status` flip captured separately in `statusFlips`).
 */
export function diffRuns(
  before: RunRecord,
  after: RunRecord,
): DiffReport {
  const beforeByPid = new Map<string, RunCaseResult>();
  for (const c of before.cases) {
    beforeByPid.set(c.patientId, c);
  }
  const afterByPid = new Map<string, RunCaseResult>();
  for (const c of after.cases) {
    afterByPid.set(c.patientId, c);
  }

  const added: RunCaseResult[] = [];
  const removed: RunCaseResult[] = [];
  const changed: DiffReport['changed'] = [];
  const statusFlips: DiffReport['statusFlips'] = [];
  let unchangedCount = 0;

  for (const [pid, afterCase] of afterByPid) {
    const beforeCase = beforeByPid.get(pid);
    if (!beforeCase) {
      added.push(afterCase);
      continue;
    }
    if (beforeCase.status !== afterCase.status) {
      statusFlips.push({ patientId: pid, before: beforeCase.status, after: afterCase.status });
    }
    const exprChanges = compareExpressions(beforeCase.expressions, afterCase.expressions);
    if (exprChanges.length === 0 && beforeCase.status === afterCase.status) {
      unchangedCount++;
    } else {
      changed.push(...exprChanges.map((c) => ({ patientId: pid, ...c })));
    }
    // expression-removed entries are inherently not a "value change" — they
    // mean the CQL author renamed/removed the define between runs. We still
    // count the case as changed, so no additional handling is needed here.
    // expression-added entries likewise.
  }

  for (const [pid, beforeCase] of beforeByPid) {
    if (!afterByPid.has(pid)) {
      removed.push(beforeCase);
    }
  }

  const summary = buildSummary({
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    statusFlips: statusFlips.length,
    unchanged: unchangedCount,
  });

  return {
    suite: after.suiteName,
    runA: before.hash,
    runB: after.hash,
    added,
    removed,
    changed,
    statusFlips,
    unchangedCount,
    summary,
  };
}

function compareExpressions(
  before: RunCaseResult['expressions'],
  after: RunCaseResult['expressions'],
): Array<{ expressionName: string; before: string; after: string; kind: 'value-changed' | 'expression-added' | 'expression-removed' }> {
  const out: Array<{ expressionName: string; before: string; after: string; kind: 'value-changed' | 'expression-added' | 'expression-removed' }> = [];
  const beforeByName = new Map(before.map((e) => [e.name, e.value]));
  const afterByName = new Map(after.map((e) => [e.name, e.value]));
  // Detect value changes and additions (expressions only in `after`).
  for (const [name, afterValue] of afterByName) {
    const beforeValue = beforeByName.get(name);
    if (beforeValue === undefined) {
      out.push({ expressionName: name, before: '', after: afterValue, kind: 'expression-added' });
    } else if (beforeValue !== afterValue) {
      out.push({ expressionName: name, before: beforeValue, after: afterValue, kind: 'value-changed' });
    }
  }
  // Detect removals (expressions only in `before`).
  for (const [name, beforeValue] of beforeByName) {
    if (!afterByName.has(name)) {
      out.push({ expressionName: name, before: beforeValue, after: '', kind: 'expression-removed' });
    }
  }
  return out;
}

function buildSummary(counts: {
  added: number;
  removed: number;
  changed: number;
  statusFlips: number;
  unchanged: number;
}): string {
  return [
    `${counts.added} added`,
    `${counts.removed} removed`,
    `${counts.changed} expression changes`,
    `${counts.statusFlips} status flips`,
    `${counts.unchanged} unchanged`,
  ].join(', ');
}

/**
 * Convenience wrapper: when `previous` is null (no prior run recorded), returns
 * a NoPreviousRunReport. Otherwise produces a normal DiffReport.
 */
export function diffRunsOrNoPrevious(
  suite: string,
  before: RunRecord | null,
  after: RunRecord,
): DiffReport | NoPreviousRunReport {
  if (!before) {
    return {
      status: 'no_previous_run',
      suite,
      message: `No previous run recorded for suite "${suite}". Run cql_test_run_suite at least twice to diff.`,
    };
  }
  return diffRuns(before, after);
}
