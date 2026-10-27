// The Init dialog's time limit (src/client/initLimit.ts): a failed Init reads
// as timed out only when it ran at least its limit (its own, else LayerFS's
// default); the minutes field and the next limit offered after a time-out.
//   node packages/client/tests/initlimit.mjs
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LAYERFS } from "../../host/src/source.js";
import { DEFAULT_LIMIT_MS, limitFromMinutes, limitOf, nextMinutes, timedOut, timedOutText } from "../src/client/initLimit.ts";

// the client's default is the agent's
const { INIT_TIMEOUT_MS } = await import(pathToFileURL(join(LAYERFS, "api/agent/src/project/init.js")).href);
assert.equal(DEFAULT_LIMIT_MS, INIT_TIMEOUT_MS);

const job = (fields) => ({ step: "failed", started: 1_000, ended: null, timeout: null, imported: null, totals: null, ...fields });
const MIN = 60_000;

// LayerFS's default limit: 5 min
assert.equal(timedOut(job({ ended: 1_000 + 5 * MIN })), true, "ended at the limit");
assert.equal(timedOut(job({ ended: 1_000 + 5 * MIN + 2_000 })), true);
assert.equal(timedOut(job({ ended: 1_000 + 5 * MIN - 1 })), false, "failed before the limit: another failure");
assert.equal(timedOut(job({ ended: 1_000 + 3_000 })), false);
// the job's own limit
assert.equal(timedOut(job({ timeout: 15 * MIN, ended: 1_000 + 6 * MIN })), false, "past the default but within its own limit");
assert.equal(timedOut(job({ timeout: 15 * MIN, ended: 1_000 + 15 * MIN })), true);
assert.equal(timedOut(job({ timeout: 2 * MIN, ended: 1_000 + 2 * MIN })), true, "a limit below the default");
// only a failed, ended job
assert.equal(timedOut(job({ step: "done", ended: 1_000 + 10 * MIN })), false);
assert.equal(timedOut(job({ step: "import", ended: null })), false);
assert.equal(limitOf({ timeout: null }), 5 * MIN);

// the message: the limit and how far the import got, when known
assert.equal(timedOutText(job({ timeout: 15 * MIN, imported: { step: "files", entries: 900, files: 812, bytes: 1 }, totals: { entries: 3000, files: 2_400, bytes: 9 } })),
  "Init stopped at its 15 min limit after importing 812 of 2,400 files.");
assert.equal(timedOutText(job({})), "Init stopped at its 5 min limit.");

// the next limit: the next quick pick, past the last one twice the limit
assert.deepEqual([5, 15, 30, 60, 90].map((m) => nextMinutes(m * MIN)), [15, 30, 60, 120, 180]);
assert.equal(nextMinutes(2 * MIN), 5);

// the minutes field: blank sends nothing; whole minutes ≥ 1 become ms
assert.deepEqual(limitFromMinutes("  "), {});
assert.deepEqual(limitFromMinutes("15"), { ms: 15 * MIN });
for (const text of ["0", "-5", "1.5", "ten", "1e3"]) assert.ok(limitFromMinutes(text).error, text);

console.log("initlimit: ok");
