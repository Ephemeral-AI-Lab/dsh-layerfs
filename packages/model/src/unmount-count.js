// The Use Case: an unmount outcome the Host observes is journaled through
// the port, and the outcomes a project journaled are counted by stage and
// abort disposition. The port is an interface the Host's adapter implements
// (packages/host/src/unmount-journal.js, the state folder's unmounts.jsonl);
// this module holds no I/O, and it depends only on the Entities value
// (unmount.js). A plain unmount has no section and is not recorded.
import { ABORTS, STAGES, outcomeOf } from "./unmount.js";

/**
 * Counts of journaled outcomes: by stage and abort disposition, with the
 * waited time's total and longest. A value outside the stable sets is counted
 * under its own key, so a later daemon's stage is not lost.
 * @param {object[]} records journal records
 */
export function countOf(records) {
  const counts = {
    total: 0,
    byStage: Object.fromEntries(STAGES.map((stage) => [stage, 0])),
    byAbort: Object.fromEntries(ABORTS.map((abort) => [abort, 0])),
    waitedMs: { total: 0, max: 0 },
  };
  for (const record of records) {
    if (!record) continue;
    counts.total += 1;
    counts.byStage[record.stage] = (counts.byStage[record.stage] ?? 0) + 1;
    counts.byAbort[record.abort] = (counts.byAbort[record.abort] ?? 0) + 1;
    const waited = Number.isSafeInteger(record.waitedMs) ? record.waitedMs : 0;
    counts.waitedMs.total += waited;
    counts.waitedMs.max = Math.max(counts.waitedMs.max, waited);
  }
  return counts;
}

/**
 * The unmount outcomes of traced unmounts: each is journaled through the
 * port, and a project's aggregate is counted from the journal, so the counts
 * outlive the Host and always match the journal.
 */
export class UnmountOutcomes {
  /** @param {{ append(record: object): void, records(project: string): object[] }} journal the journal port */
  constructor(journal) {
    this.journal = journal;
  }

  /**
   * Records one finished trace line's unmount outcome, when it has one.
   * @param {{ project: string|null, agent: string|null, at: number|null, line: object }} seen
   * @returns {object|null} the journaled record, or null for a line with no section
   */
  record({ project, agent, at, line }) {
    const outcome = outcomeOf(line);
    if (!outcome) return null;
    const record = { at: at ?? null, project: project ?? null, agent: agent ?? null, id: line?.id ?? null, ...outcome };
    this.journal.append(record);
    return record;
  }

  /** A project's counts and its journaled records, oldest first. */
  summaryOf(project) {
    const records = this.journal.records(project);
    return { ...countOf(records), records };
  }
}
