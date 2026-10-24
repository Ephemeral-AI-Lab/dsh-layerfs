// Fan-out: an agent (say, running a script) may hold several Workspaces at
// once. It stands where its last call ran; each other Workspace it holds
// gets a faint copy, and the agent shows ×N for the places it works in.
import { where } from "./where.js";

export function fanOf(W, n) {
  const l = where(W, n),
    others = Object.values(W.ws).filter((w) => w.agent === n && !(l.kind === "ws" && l.ws === w.id));
  return { n: others.length + (l.kind === "bench" ? 0 : 1), others };
}

/** Where a copy stands for view tab `active`: the Branch row on main, the
 * Branch's tab chip elsewhere, its pane on its own Branch tab. */
export function ghostSpot(active, w) {
  if (active === "main") return { loc: "row:" + w.branch, mode: "row" };
  if (w.branch !== active) return { tab: w.branch, mode: "chip" };
  return { loc: "ws:" + w.id, mode: "pane" };
}

/** Where an agent stands for view tab `active`: a `data-loc` key, a tab chip,
 * or nothing when this tab has nothing to say about it. */
export function spotOf(W, n, active, recently) {
  const l = where(W, n);
  if (l.kind === "bench") return active !== "main" && recently.includes(n) ? { loc: "bench", mode: "bench" } : null;
  if (active === "main")
    return l.kind === "hist" ? { loc: "hist", mode: "term" } : { loc: "row:" + l.branch, mode: "row" };
  if (l.kind === "hist") return { tab: "main", mode: "chip" };
  if (l.branch !== active) return { tab: l.branch, mode: "chip" };
  return l.kind === "ws" ? { loc: "ws:" + l.ws, mode: "pane" } : { loc: "fs:" + l.branch, mode: "term" };
}
