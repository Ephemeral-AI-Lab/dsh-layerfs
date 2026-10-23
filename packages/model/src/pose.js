// What an agent is doing, as a pose name: the outcome of its call in this
// step first, then where it is. Sprite sheets map pose names to frames; the
// lead's sheet has expressions instead, mapped by LEAD_POSES.
import { where } from "./where.js";

export const POSES = ["idle", "sleep", "laptop", "read", "cheer", "arms_open", "heart", "serve_tea", "wave", "conflict", "refused", "failed", "run"];
export const LEAD_POSES = { idle: "shy", sleep: "sleepy", laptop: "thinking", read: "thinking", cheer: "thumbs_up", arms_open: "happy", heart: "smug", serve_tea: "happy", wave: "happy", conflict: "crying", refused: "surprised", failed: "angry" };

/** True while a running process belongs to Workspace `wsId` ("sb_01:/workspaces/2"). */
export function serving(W, wsId) {
  const i = wsId.indexOf(":"), id = wsId.slice(0, i), sb = W.engine.s.sandboxes[id];
  return !!sb && (sb.procOrder || []).some((p) => sb.processes[p].status === "running" && `${id}:${sb.processes[p].path}` === wsId);
}

/** `mode` is the host the agent stands on ("bench", "row", "term", "pane",
 * "chip"); `acting` is true for the agent(s) of the current step. */
export function poseOf(W, n, mode, acting) {
  const A = W.agents[n], o = A.out && A.out.tick === W.tick ? A.out : null, l = where(W, n);
  const mine = Object.values(W.ws).filter((w) => w.agent === n);
  if (A.spawned === W.tick) return "wave";
  if (o && !o.ok) return o.code === "Conflict" ? "conflict" : "refused";
  if (o && o.code === "Committed") return "cheer";
  if (o && o.code === "Merged") return "arms_open";
  if (o && o.code === "Added") return "heart";
  if (o && o.proc) return "serve_tea";
  if (o && o.exit) return "failed";
  if (mine.some((w) => w.bad)) return "conflict";
  if (mode === "bench") return W.clock - A.lastT > 40 ? "sleep" : "idle";
  if (acting && l.kind === "ws") return "laptop";
  if (acting && (l.kind === "fs" || l.kind === "hist")) return "read";
  if (mine.some((w) => serving(W, w.id))) return "serve_tea";
  return "idle";
}

/** A fan-out copy's pose: what its Workspace is doing. */
export const ghostPose = (W, w) => (w.bad ? "conflict" : serving(W, w.id) ? "serve_tea" : "laptop");
