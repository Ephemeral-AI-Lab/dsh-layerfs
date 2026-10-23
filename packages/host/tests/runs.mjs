// The Runs player's reads (src/runs.js) and routes on run folders shaped like
// the history replay harness's, made from the model's recorded trace: files
// only, no Store, no Docker.
//   node packages/host/tests/runs.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRuns, readRange } from "../src/runs.js";
import { registerRoutes } from "../src/route.js";

const fixture = readFileSync(new URL("../../model/tests/fixtures/real-trace.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const ends = fixture.filter((l) => l.phase !== "start");
// the harness's step labels: the plan's steps, a step's own parts, and the lead's
const labels = ["r001.fork", "r001.s0001", "r001.s0001.git-commit", "r001.s0002", "probe-s4:oneshot_commit"];
const traced = fixture.map((l, i) => ({ ...l, step: `${labels[i % labels.length]}#${i}`, daemon: [{ sql: { statements: 3 } }], queue: { ms: 0.1 } }));
const jsonl = (lines) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

const dir = mkdtempSync(join(tmpdir(), "dsh-layerfs-runs-"));
try {
  const runs = join(dir, "runs"), plan = join(dir, "plan");
  mkdirSync(plan);
  writeFileSync(join(plan, "range-001.json"), JSON.stringify({
    range: 1, checkpoint: "34bb75b2", lanes: [{ name: "r001-1-docs" }, { name: "r001-2-core" }],
    steps: [{ id: "r001.s0001", agent: "a01" }, { id: "r001.s0002", agent: "a02" }], conflicts: [{ kind: "commit-conflict" }],
  }));
  const run = (id, manifest, files) => {
    mkdirSync(join(runs, id, "trace"), { recursive: true });
    mkdirSync(join(runs, id, "metrics"), { recursive: true });
    if (manifest) writeFileSync(join(runs, id, "run.json"), JSON.stringify(manifest));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(runs, id, name), text);
  };
  run("p3-slice", { run: "p3-slice", phase: "p3", label: "dev", project: "dsh", created: "2026-10-19T08:26:33.739Z", plan }, {
    "trace/range-001.a1.jsonl": jsonl(traced) + "not json\n" + JSON.stringify({ other: 1 }) + "\n",
    "trace/range-001.a1.calls.jsonl": jsonl([{ seq: 1, method: "fs.write" }]),
    "trace/range-002.a2.jsonl": jsonl(traced.slice(0, 4)),
    "trace/range-002.a1.jsonl": jsonl(traced.slice(0, 2)),
    "metrics/range-001.a1.json": JSON.stringify({ range: 1, attempt: 1, mode: "measured", started: "2026-10-19T08:26:42.408Z", gate: { verdict: "watch", reason: "Speed: not judged" } }),
  });
  run("older", { run: "older", phase: "p1", label: "measured", created: "2026-10-01T00:00:00.000Z", plan: join(dir, "moved-plan") }, { "trace/range-000.a1.jsonl": jsonl(traced.slice(0, 3)) });
  run("fast-only", { run: "fast-only", created: "2026-10-20T00:00:00.000Z" }, {});
  run("no-manifest", null, { "trace/range-001.a1.jsonl": jsonl(traced) });
  run("Not_A_Run", { created: "2026-10-21T00:00:00.000Z" }, { "trace/range-001.a1.jsonl": jsonl(traced) });

  // runs with a traced range, newest first; their ranges in order with the gate's verdict
  const list = listRuns(runs);
  assert.deepEqual(list.map((r) => r.id), ["p3-slice", "older"]);
  assert.deepEqual(list[0].ranges.map((r) => [r.range, r.attempt, r.verdict]), [[1, 1, "watch"], [2, 1, null], [2, 2, null]]);
  assert.deepEqual([list[0].phase, list[0].label, list[0].project, list[0].ranges[0].started], ["p3", "dev", "dsh", "2026-10-19T08:26:42.408Z"]);
  assert.deepEqual(listRuns(join(dir, "nowhere")), []);

  // a range: its end lines in call order, telemetry dropped, each line's agent from the plan
  const r = readRange(runs, "p3-slice", "1", "1");
  assert.equal(r.lines.length, ends.length);
  assert.ok(r.lines.every((l) => l.phase !== "start" && !("daemon" in l) && !("queue" in l)));
  for (let i = 1; i < r.lines.length; i++) assert.ok(Date.parse(r.lines[i].start) >= Date.parse(r.lines[i - 1].start));
  const agentOf = (label) => r.lines.find((l) => l.step.replace(/#\d+$/, "") === label)?.agent;
  assert.deepEqual(labels.map(agentOf), ["main", "a01", "a01", "a02", "main"]);
  assert.deepEqual(r.agents, ["main", "a01", "a02"]);
  assert.deepEqual(r.plan, { checkpoint: "34bb75b2", lanes: ["r001-1-docs", "r001-2-core"], steps: 2, conflicts: 1 });
  assert.deepEqual([r.verdict, r.reason], ["watch", "Speed: not judged"]);
  // a run whose plan moved: every line is the lead's
  const older = readRange(runs, "older", 0, 1);
  assert.deepEqual([older.plan, [...new Set(older.lines.map((l) => l.agent))]], [null, ["main"]]);

  // refusals: never outside the runs folder, nothing guessed
  const refused = (f, code) => assert.throws(f, { code });
  refused(() => readRange(runs, "../plan", 1, 1), "invalid-run");
  refused(() => readRange(runs, "p3-slice", "", 1), "invalid-range");
  refused(() => readRange(runs, "p3-slice", "1/../2", 1), "invalid-range");
  refused(() => readRange(runs, "p3-slice", 1, 0), "invalid-range");
  refused(() => readRange(runs, "p3-slice", 3, 1), "not-found");
  refused(() => readRange(runs, "no-such-run", 1, 1), "not-found");
  refused(() => readRange(runs, "p3-slice", 1, 1, { max: 100 }), "too-large");

  // the routes, behind Connection's checks like every /layerfs request
  let handler;
  const ctx = { effect: (fn) => fn(), webServer: { register: (route) => { handler = route.handler; return () => {}; } }, connection: { requestRejection: (req) => (req.headers.cookie ? undefined : 401) } };
  registerRoutes(ctx, { spec: { runs }, bindings: {}, collector: {}, trees: {}, jobs: {} });
  const call = async (url, cookie = "dsh=1") => {
    const res = { statusCode: 0, text: "", setHeader() {}, end(text = "") { this.text = text; } };
    await handler({ method: "GET", url, headers: cookie ? { cookie } : {} }, res);
    return { status: res.statusCode, body: res.text ? JSON.parse(res.text) : null };
  };
  assert.equal((await call("/layerfs/runs", null)).status, 401);
  const listed = await call("/layerfs/runs");
  assert.deepEqual([listed.status, listed.body.dir, listed.body.runs.map((x) => x.id)], [200, runs, ["p3-slice", "older"]]);
  const range = await call("/layerfs/runs/p3-slice/trace?range=2&attempt=2");
  assert.deepEqual([range.status, range.body.range, range.body.attempt, range.body.lines.length], [200, 2, 2, traced.slice(0, 4).filter((l) => l.phase !== "start").length]);
  assert.equal((await call("/layerfs/runs/p3-slice/trace?range=1")).body.attempt, 1, "attempt 1 by default");
  assert.deepEqual([(await call("/layerfs/runs/p3-slice/trace")).status, (await call("/layerfs/runs/p3-slice/trace?range=9")).status, (await call("/layerfs/runs/..%2Fplan/trace?range=1")).status], [400, 404, 400]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("runs: ok");
