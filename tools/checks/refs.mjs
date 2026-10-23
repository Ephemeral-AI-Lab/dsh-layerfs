// A recorded Commit ref "branch#i" read in a replay (scenarios/shared/replay.mjs).
// i counts the record's own Commits on the Branch, an optional one
// (Committed|UpToDate) as made (tools/import-run.mjs). A replay may skip an
// optional one, or make a Commit the record has as UpToDate (generated files
// only); it notes both per Branch: `skipped` holds record indices, `extra`
// this run's. A ref to a skipped Commit names the one before it, as the
// importer names a Commit a run does not make.

/** This run's index of the record's Commit `i`, or -1 when it and every Commit before it were skipped. */
export function runIndex(i, { skipped, extra }) {
  while (i >= 0 && skipped.includes(i)) i--;
  if (i < 0) return -1;
  let made = 0;
  for (let r = 0; r < i; r++) if (!skipped.includes(r)) made++;
  for (let j = 0, seen = 0; ; j++) {
    if (extra.includes(j)) continue;
    if (seen === made) return j;
    seen++;
  }
}

/**
 * The record index of a skipped Commit, or this run's index of an extra one,
 * given how many own Commits the Branch has now (after the Commit call).
 */
export const differenceAt = (kind, count, { skipped, extra }) =>
  kind === "skipped" ? count - extra.length + skipped.length : count - 1;
