// The normal unmount's abort-path value and its counting: the `unmount`
// telemetry section of a traced unmount (layerfs #501,
// tokenaissance/layerfs#2), parsed as an Entities value, journaled through the
// use case's port and counted by stage and abort disposition. A plain unmount
// carries no section, so it records nothing.
//   node packages/model/tests/unmount.mjs
import assert from "node:assert/strict";
import { ABORTS, KEYS, STAGES, outcomeOf, sectionOf } from "../src/unmount.js";
import { UnmountOutcomes, countOf } from "../src/unmount-count.js";

const START = "2026-10-29T00:00:00.000Z";
const trace = (section, extra = {}) => ({
  layerfs_trace: 1, id: "u-1", method: "workspace.unmount", args: {}, start: START, ms: 5000, phase: "end",
  ok: true, kind: "Unmounted", scope: "ab", daemon: [{ timing: [] }, ...(section ? [{ timing: [], unmount: section }] : [])], ...extra,
});
const written = { stage: "Join", abort: "Written", detached: true, loops_exited: 3, loops_joined: 3, active: 0, retained: 0, waited_ms: 5000 };

// The section's stable key set, as the daemon writes it, and where it sits.
assert.deepEqual(KEYS, ["stage", "abort", "bytes", "errno", "detached", "loops_exited", "loops_joined", "active", "retained", "waited_ms"]);
assert.deepEqual(STAGES, ["Join", "Abort", "Revoke", "Close"]);
assert.deepEqual(ABORTS, ["Written", "Short", "Failed"]);
assert.deepEqual(sectionOf(trace(written)), written);
assert.equal(sectionOf(trace(null)), null);
assert.equal(sectionOf({ layerfs_trace: 1, daemon: { t: 1 } }), null, "daemon is a list of telemetry maps");
assert.equal(sectionOf({}), null);

// Success: `Unmounted`, an abort write that was accepted whole, no bytes or errno.
assert.deepEqual(outcomeOf(trace(written)), {
  stage: "Join", abort: "Written", detached: true, loopsExited: 3, loopsJoined: 3, active: 0, retained: 0, waitedMs: 5000, reply: "Unmounted",
});
// A short write owns its byte count; a failed write owns its errno; never both.
assert.deepEqual(outcomeOf(trace({ ...written, stage: "Revoke", abort: "Short", bytes: 0 })), {
  stage: "Revoke", abort: "Short", bytes: 0, detached: true, loopsExited: 3, loopsJoined: 3, active: 0, retained: 0, waitedMs: 5000, reply: "Unmounted",
});
assert.deepEqual(outcomeOf(trace({ ...written, stage: "Abort", abort: "Failed", errno: "EIO" })), {
  stage: "Abort", abort: "Failed", errno: "EIO", detached: true, loopsExited: 3, loopsJoined: 3, active: 0, retained: 0, waitedMs: 5000, reply: "Unmounted",
});
// A retained stop keeps the section and answers a refusal; the reply's code is kept.
assert.deepEqual(outcomeOf(trace({ ...written, stage: "Close", detached: false, retained: 2 }, { ok: false, kind: undefined, code: "Failed", message: "Retained: TeardownCustody { stage: Close }" })), {
  stage: "Close", abort: "Written", detached: false, loopsExited: 3, loopsJoined: 3, active: 0, retained: 2, waitedMs: 5000, reply: "Failed",
});
// A section outside the stable sets is kept and counted under its own key, not dropped.
assert.equal(outcomeOf(trace({ ...written, stage: "Detach" })).stage, "Detach");
// A plain unmount has no section at all.
assert.equal(outcomeOf(trace(null)), null);
assert.equal(outcomeOf({ layerfs_trace: 1, method: "workspace.unmount", ok: true, kind: "Unmounted" }), null);
// A section that lost its strings is not an outcome.
assert.equal(outcomeOf(trace({ abort: "Written" })), null);
assert.equal(outcomeOf(trace({ stage: 7, abort: "Written" })), null);

// Counting: zeros first, then by stage and disposition, with the waited time's total and longest.
assert.deepEqual(countOf([]), { total: 0, byStage: { Join: 0, Abort: 0, Revoke: 0, Close: 0 }, byAbort: { Written: 0, Short: 0, Failed: 0 }, waitedMs: { total: 0, max: 0 } });
const records = [
  { stage: "Join", abort: "Written", waitedMs: 5000 },
  { stage: "Join", abort: "Short", waitedMs: 3000 },
  { stage: "Revoke", abort: "Failed", waitedMs: 4000 },
  { stage: "Detach", abort: "Written", waitedMs: 0 },
];
assert.deepEqual(countOf(records), {
  total: 4, byStage: { Join: 2, Abort: 0, Revoke: 1, Close: 0, Detach: 1 }, byAbort: { Written: 2, Short: 1, Failed: 1 }, waitedMs: { total: 12_000, max: 5000 },
});

// The use case records through its journal port only when the line has a section.
const appended = [];
const outcomes = new UnmountOutcomes({ append: (record) => appended.push(record), records: (project) => appended.filter((record) => record.project === project) });
assert.equal(outcomes.record({ project: "p", agent: "main", at: 1, line: trace(null) }), null);
assert.equal(outcomes.record({ project: "p", agent: "main", at: 1, line: trace(written) }).stage, "Join");
outcomes.record({ project: "p", agent: "main", at: 2, line: trace({ ...written, stage: "Revoke", abort: "Short", bytes: 0 }, { ok: false, code: "Failed" }) });
outcomes.record({ project: "q", agent: "main", at: 3, line: trace({ ...written, stage: "Close", abort: "Failed", errno: "EIO" }) });
assert.deepEqual(appended.map((record) => [record.project, record.id, record.stage, record.abort]), [["p", "u-1", "Join", "Written"], ["p", "u-1", "Revoke", "Short"], ["q", "u-1", "Close", "Failed"]]);
assert.deepEqual(outcomes.summaryOf("p"), {
  total: 2, byStage: { Join: 1, Abort: 0, Revoke: 1, Close: 0 }, byAbort: { Written: 1, Short: 1, Failed: 0 }, waitedMs: { total: 10_000, max: 5000 },
  records: [appended[0], appended[1]],
});
assert.deepEqual([outcomes.summaryOf("other").total, outcomes.summaryOf("other").records], [0, []]);
console.log("PASS model unmount: the abort-path value, its counts and its journal port");
