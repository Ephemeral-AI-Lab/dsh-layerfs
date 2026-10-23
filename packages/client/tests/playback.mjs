// The LayerFS tab's playback (src/client/playback.ts) on the model's recorded
// trace: past calls apply at once and draw once; recent ones show at their
// own time, LAG_MS after they ended, in order; a line seen twice plays once.
//   node packages/client/tests/playback.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as X from "../../model/src/index.js";
import { dueOf, Playback } from "../src/client/playback.ts";

const lines = X.parseTrace(readFileSync(new URL("../../model/tests/fixtures/real-trace.jsonl", import.meta.url), "utf8"));
const ends = X.endLines(lines), steps = ends.filter((l) => !X.ridesAlong(l.method)).length;
// the same calls, moved so the last ended `ago` ms before now
const at = (ago) => {
  const shift = Date.now() - ago - Math.max(...ends.map((l) => Date.parse(l.start) + (l.ms || 0)));
  return lines.map((l) => ({ ...l, start: new Date(Date.parse(l.start) + shift).toISOString() }));
};
const fresh = () => X.storyView(new X.ReplayEngine({ project: "website" }), { lead: "main" });

// an hour ago: all at once, one draw that only catches up
{
  const shows = [], p = new Playback(fresh, (W, step) => shows.push(step));
  await p.feed(at(3_600_000), "main");
  assert.deepEqual([p.played, p.waiting, shows], [steps, 0, [null]]);
  await p.feed(at(3_600_000), "main"); // the next poll: nothing new
  assert.equal(p.played, steps);
}

// just ended: each recent call shows at its own time, in order, never early
{
  const shows = [], p = new Playback(fresh, (W, step) => shows.push([step && step.line.id, Date.now(), step && step.due]));
  const recent = at(0);
  await p.feed(recent, "main");
  assert.equal(p.played, steps);
  assert.ok(shows.length > 1, "recent calls draw one by one");
  for (const [id, t, due] of shows) if (id) assert.ok(t >= due - 5, `${id} showed ${due - t} ms early`);
  const last = X.endLines(recent).at(-1);
  assert.ok(shows.at(-1)[1] >= dueOf(last) - 5);
  for (let i = 1; i < shows.length; i++) assert.ok(shows[i][1] >= shows[i - 1][1]);
}

// stopped: nothing more plays
{
  const shows = [], p = new Playback(fresh, (W, step) => shows.push(step));
  const done = p.feed(at(0), "main");
  p.stop();
  await done;
  assert.ok(p.played < steps);
}
console.log(`playback: ok (${steps} steps)`);
