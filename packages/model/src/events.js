// The event contract (#345): one agent call is
//   { agent, call, args, outcome, timing, group }
// where `call` is an SDK method in the story's names (main.fork for a fork
// from main, process.cancel, sandbox.exec with args.background for a
// process start), `outcome` is { ok, code, result | refusal } with display
// ids, and `group` names the script or bash call that made it.
//
// Sources produce story steps that runStep plays into a view:
//   sources/story.js    scripted stories
//   sources/trace.js    SDK trace lines (LAYERFS_TRACE / DSH_LAYERFS_TRACE)
//   sources/records.js  dsh session records, which carry trace lines
import { endLines } from "./sources/trace.js";

/** The events of trace lines, in call order, for tests and inspection. */
export function traceEvents(lines, agent = "main") {
  return endLines(lines).map((l) => ({
    agent: l.agent || agent, call: l.method, args: l.args, group: l.step || null,
    outcome: l.ok ? { ok: true, code: l.kind || "ok" } : { ok: false, code: l.code },
    timing: { totalMs: l.ms },
  }));
}
