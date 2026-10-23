// The Runs player (src/client/runplayer.ts) on the model's recorded trace,
// split into two ranges hours apart: idle gaps are cut to MAX_GAP_MS; play,
// pause and speed move the clock; a seek back rebuilds; and every way of
// reaching a point leaves the same model as playing to it step by step.
//   node packages/client/tests/runplayer.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as X from "../../model/src/index.js";
import { catchUp, clock, MAX_GAP_MS, RunPlayer, schedule } from "../src/client/runplayer.ts";

const lines = X.endLines(X.parseTrace(readFileSync(new URL("../../model/tests/fixtures/real-trace.jsonl", import.meta.url), "utf8")));
const HOURS = 5 * 3_600_000, half = Math.floor(lines.length / 2);
// range 1, then range 2 five hours later (another process: other call ids)
const run = lines.map((l, i) => i < half ? { ...l, range: 1 } : { ...l, range: 2, id: `r2-${l.id}`, start: new Date(Date.parse(l.start) + HOURS).toISOString() });
const timeline = schedule(run);
const { steps, duration } = timeline;
const fresh = () => X.storyView(new X.ReplayEngine({ project: "website" }), { lead: "main" });
// what the views draw from: the mirror's state, the nodes and who made them
const picture = (W) => JSON.stringify([W.engine.m.s, Object.keys(W.nodes).sort(), W.attrib]);

// the timeline: in order, gaps at most MAX_GAP_MS, the five hours gone, real time kept
assert.equal(steps.length, X.traceSteps(run).length);
for (let i = 1; i < steps.length; i++) {
  const gap = steps[i].t - steps[i - 1].t;
  assert.ok(gap >= 0 && gap <= MAX_GAP_MS, `step ${i}: gap ${gap}`);
}
assert.ok(duration < steps.at(-1).real - HOURS + MAX_GAP_MS, "the idle hours are cut");
assert.ok(steps.at(-1).real > HOURS, "real time is kept beside");
assert.deepEqual([...new Set(steps.map((s) => s.range))], [1, 2]);
assert.deepEqual(schedule(run, { maxGap: 0 }).duration, 0);

// the reference: every step played one by one
const reference = fresh();
for (const st of steps) await X.runStep(reference, st, {});
const middle = steps[Math.floor(steps.length / 2)].t;
const referenceAt = (t) => { const W = fresh(); catchUp(W, steps.filter((s) => s.t <= t)); return picture(W); };
assert.equal(referenceAt(Infinity), picture(reference), "catching up draws what step-by-step play draws");

// play: nothing moves while paused; at 1× a short frame plays a lone step, animated
{
  const shows = [];
  const p = new RunPlayer(timeline, fresh, (W, step) => shows.push(step));
  await p.advance(10_000);
  assert.deepEqual([p.position, p.index, shows.length], [0, 0, 0], "paused: the clock stands");
  p.play();
  await p.advance(1);
  assert.ok(p.index >= 1 && shows.length === 1);
  let frames = 0;
  while (!p.ended && frames++ < 100_000) await p.advance(100);
  assert.ok(p.ended && !p.playing, "it stops at the end");
  assert.ok(shows.filter(Boolean).length > 1, "lone steps animate");
  assert.equal(picture(p.W), picture(reference));
  // Play at the end starts again from the beginning
  p.play();
  await p.advance(0);
  assert.equal(p.index, steps.filter((s) => s.t === 0).length);
}

// speed: 64× covers 64 times the timeline per frame, catching up and drawing once
{
  const shows = [];
  const p = new RunPlayer(timeline, fresh, (W, step) => shows.push(step));
  p.setSpeed(64);
  p.play();
  await p.advance(100);
  assert.equal(p.position, Math.min(duration, 6400));
  assert.equal(p.index, steps.filter((s) => s.t <= 6400).length);
}

// seek: forward and back to the same point leave the same model; back rebuilds
{
  const shows = [];
  const p = new RunPlayer(timeline, fresh, (W, step) => shows.push(step));
  await p.seek(middle);
  const there = picture(p.W);
  assert.equal(there, referenceAt(middle));
  await p.seek(duration);
  await p.seek(middle);
  assert.equal(picture(p.W), there, "seeking back rebuilds the same model");
  assert.ok(shows.every((s) => s === null), "a seek draws once, without animation");
  await p.seek(-5);
  assert.deepEqual([p.position, p.index], [0, steps.filter((s) => s.t === 0).length]);
  await p.seek(duration * 2);
  assert.equal(p.index, steps.length);
  // a range's start, for its chip
  assert.equal(p.startOf(1), 0);
  assert.equal(p.startOf(2), steps.find((s) => s.range === 2).t);
  assert.equal(p.startOf(3), null);
  await p.seek(p.startOf(2));
  assert.equal(p.current.range, 2);
}

// moves queued together run in order
{
  const p = new RunPlayer(timeline, fresh, () => {});
  p.play();
  await Promise.all([p.seek(duration), p.seek(0), p.advance(0), p.seek(middle)]);
  assert.equal(picture(p.W), referenceAt(middle));
}

assert.deepEqual([clock(0), clock(61_500), clock(3_725_000)], ["0:00", "1:01", "1:02:05"]);
console.log(`runplayer: ok (${steps.length} steps, ${clock(duration)} of timeline)`);
