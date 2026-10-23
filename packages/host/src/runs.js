// Recorded history replay runs (layerfs #352) for the Runs player: each run's
// traced ranges and their SDK trace lines, read from the run folders the
// replay harness writes. Files only: no Store call, no Docker, nothing written.
//   <runs>/<id>/run.json                      the run's manifest (phase, label, created, plan)
//   <runs>/<id>/trace/range-NNN.aK.jsonl      attempt K of range NNN's trace (measured mode only)
//   <runs>/<id>/metrics/range-NNN.aK.json     its metrics, with the gate's verdict
//   <plan>/range-NNN.json                     the range's plan: lanes, agents, each step's agent
// A trace line's step is `<plan step id>[.<part>]#<seq>`; a step the plan does
// not name (the lead's fork, installs, probes) is the lead's, drawn as "main".
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** A run id as the harness makes them. */
export const RUN_ID = /^[a-z0-9][a-z0-9-]{0,99}$/;
const TRACE = /^range-(\d+)\.a(\d+)\.jsonl$/;
/** The largest trace file read (about 9× a 2,000-call range). */
export const MAX_TRACE = 64 * 1024 * 1024;
/** Per-call telemetry the views never read; dropped, a range is about a sixth of its file. */
const TELEMETRY = ["daemon", "queue"];
const LEAD = "main";

const refuse = (code, message, status) => Object.assign(new Error(message), { code, status });
const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };
const pad = (k) => String(k).padStart(3, "0");

/**
 * @typedef {object} RunRange
 * @property {number} range
 * @property {number} attempt
 * @property {number} bytes the trace file's size
 * @property {string|null} verdict the gate's verdict (pass, watch, optimize, stop), from the range's metrics
 * @property {string|null} reason
 * @property {string|null} started
 */

/** Every run under `dir` with at least one traced range, newest first. */
export function listRuns(dir) {
  if (!dir || !existsSync(dir)) return [];
  const runs = [];
  for (const id of readdirSync(dir)) {
    if (!RUN_ID.test(id)) continue;
    const run = readRun(dir, id);
    if (run?.ranges.length) runs.push(run);
  }
  return runs.sort((a, b) => String(b.created ?? "").localeCompare(String(a.created ?? "")) || a.id.localeCompare(b.id));
}

/** One run's manifest summary and traced ranges, or null when it has no run.json. */
function readRun(dir, id) {
  const folder = join(dir, id), manifest = readJson(join(folder, "run.json"));
  if (!manifest || typeof manifest !== "object") return null;
  let names = [];
  try { names = readdirSync(join(folder, "trace")); } catch { /* no measured range */ }
  /** @type {RunRange[]} */
  const ranges = [];
  for (const name of names) {
    const m = TRACE.exec(name);
    if (!m) continue;
    const metrics = readJson(join(folder, "metrics", `range-${m[1]}.a${m[2]}.json`));
    ranges.push({
      range: Number(m[1]), attempt: Number(m[2]), bytes: statSync(join(folder, "trace", name)).size,
      verdict: metrics?.gate?.verdict ?? null, reason: metrics?.gate?.reason ?? null, started: metrics?.started ?? null,
    });
  }
  ranges.sort((a, b) => a.range - b.range || a.attempt - b.attempt);
  return { id, phase: manifest.phase ?? null, label: manifest.label ?? null, project: manifest.project ?? null, created: manifest.created ?? null, ranges };
}

/** The plan step a trace line's step label belongs to: the label, then shorter by dotted part. */
function planStep(label, agents) {
  let id = String(label ?? "").replace(/#\d+$/, "");
  while (id) {
    if (agents.has(id)) return agents.get(id);
    const dot = id.lastIndexOf(".");
    if (dot < 0) break;
    id = id.slice(0, dot);
  }
  return null;
}

/**
 * One attempt of one range: its end lines in call order, each with the agent
 * that made it (`agent`), and what its plan and metrics say.
 * @param {string} dir the runs folder
 * @param {{ max?: number }} [o] the largest trace file read
 */
export function readRange(dir, id, range, attempt, { max = MAX_TRACE } = {}) {
  if (typeof id !== "string" || !RUN_ID.test(id)) throw refuse("invalid-run", "a run id is lowercase letters, digits and -", 400);
  const whole = (v) => /^\d{1,6}$/.test(String(v)) ? Number(v) : NaN;
  const k = whole(range), a = whole(attempt);
  if (!Number.isSafeInteger(k) || !Number.isSafeInteger(a) || a < 1) throw refuse("invalid-range", "range is a whole number and attempt 1 or more", 400);
  const folder = join(dir, id), manifest = readJson(join(folder, "run.json"));
  if (!manifest) throw refuse("not-found", `no run ${id}`, 404);
  const file = join(folder, "trace", `range-${pad(k)}.a${a}.jsonl`);
  if (!existsSync(file)) throw refuse("not-found", `run ${id} has no trace of range ${k}, attempt ${a}`, 404);
  const bytes = statSync(file).size;
  if (bytes > max) throw refuse("too-large", `range ${k}'s trace is ${bytes} bytes, over ${max}`, 413);

  const plan = typeof manifest.plan === "string" ? readJson(join(manifest.plan, `range-${pad(k)}.json`)) : null;
  const byStep = new Map((Array.isArray(plan?.steps) ? plan.steps : []).filter((s) => s && typeof s.id === "string" && typeof s.agent === "string").map((s) => [s.id, s.agent]));
  const lines = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    let line;
    try { line = JSON.parse(raw); } catch { continue; }
    if (!line || line.layerfs_trace !== 1 || line.phase === "start") continue;
    for (const key of TELEMETRY) delete line[key];
    line.agent = planStep(line.step, byStep) ?? LEAD;
    lines.push(line);
  }
  lines.sort((x, y) => Date.parse(x.start) - Date.parse(y.start) || seqOf(x) - seqOf(y));
  const metrics = readJson(join(folder, "metrics", `range-${pad(k)}.a${a}.json`));
  return {
    run: id, range: k, attempt: a, lines,
    agents: [LEAD, ...new Set(byStep.values())],
    plan: plan ? {
      checkpoint: typeof plan.checkpoint === "string" ? plan.checkpoint : null,
      lanes: Array.isArray(plan.lanes) ? plan.lanes.map((l) => l?.name).filter((n) => typeof n === "string") : [],
      steps: byStep.size,
      conflicts: Array.isArray(plan.conflicts) ? plan.conflicts.length : 0,
    } : null,
    verdict: metrics?.gate?.verdict ?? null,
    reason: metrics?.gate?.reason ?? null,
  };
}
const seqOf = (line) => Number(String(line.id).split("-").pop()) || 0;
