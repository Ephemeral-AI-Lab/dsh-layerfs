// What dsh knows and LayerFS does not: which agent made each call, where
// each agent is, and the lines each terminal printed. A view `W` holds that
// beside its engine (the simulator, the live server, or a replayed trace);
// derive() then reshapes the engine state for the views.
import { nodeOf, outcome } from "./terminals.js";
import { cliOf, routeOf } from "./cli.js";
import { engWs } from "./derive.js";

export const newAgent = () => ({ lastLoc: { kind: "bench" }, lastT: -99 });

/** A fresh view over `engine` (anything with `s`, `markersIn` and `dirtyOf`). */
export function createView(engine, { lead = "main" } = {}) {
  return {
    engine, lead, clock: 0, seq: 0, tick: 0,
    agents: { [lead]: newAgent() },
    panes: {}, fsLog: {}, hist: [], attrib: {}, touched: {}, names: {}, sbBy: {}, sbAt: {},
    flash: {}, newNodes: new Set(), lastTab: "main", last: null, check: null,
  };
}

/** Calls that run in a mounted Workspace and print in its pane (cli.js: at "workspace"); mount opens the pane. */
const inPane = (call) => routeOf(call).at === "workspace" && call !== "sandbox.mount";

/** One agent call before it runs: the Workspace it runs in (the one the step
 * binds or names, else the agent's latest), and its arguments with Sandbox
 * names resolved. `st` is `{ a, call, args, sh?, ws?, bind?, group?, as? }`. */
export function prepare(W, st) {
  const n = st.a, A = (W.agents[n] ||= newAgent()), s = W.engine.s;
  let call = st.call, args = { ...st.args };
  const bind = st.bind || (st.ws ? W.names[st.ws] : A.ws);
  const sb = bind && s.sandboxes[bind.sandbox], mine = sb && sb.workspaces[bind.path];
  const pane = bind && `${bind.sandbox}:${bind.path}`;
  const paneCall = !!st.sh || inPane(call);
  let branch;
  if (paneCall) { Object.assign(args, bind); branch = mine ? mine.branch : st.branch; }
  if (call === "process.cancel" && !args.process) {
    const run = sb ? sb.procOrder.map((id) => sb.processes[id]).filter((x) => x.path === bind.path && x.status === "running") : [];
    args = { sandbox: bind.sandbox, process: run.length ? run[run.length - 1].id : "none" };
  }
  // a Sandbox by the name a create step gave it, or by its id
  if (args.sandbox && typeof W.names[args.sandbox] === "string") args.sandbox = W.names[args.sandbox];
  if (call === "sandbox.mount") branch = args.branch;
  if (st.sh) call = "sandbox.exec";
  return { n, A, call, args, bind, mine, pane, paneCall, branch, group: st.group || null, seq: ++W.seq };
}

/** One agent call after it ran with outcome `o`: its terminal line, the
 * agent's place, and the nodes, Branches and Sandboxes it made. `shOut` is a
 * command's output lines; `calls` the SDK calls behind the line, with timing. */
export function record(W, st, p, o, shOut, calls) {
  const { n, A, call, args, pane, paneCall, group, seq } = p, s = W.engine.s;
  let branch = p.branch;
  const out = outcome(call, o, shOut, args);
  W.last = { agent: n, call, step: st, o, node: nodeOf(o) };
  A.out = outOf(call, o, W.tick);
  // a node belongs to the agent that made it; a fast-forward merge only names it again
  if (W.last.node) W.attrib[W.last.node] ??= n;
  if (o.ok && call === "sandbox.create") { W.sbBy[o.result.id] = { made: n }; if (st.as) W.names[st.as] = o.result.id; }
  if (o.ok && call === "sandbox.close") (W.sbBy[args.sandbox] ||= {}).closed = n;
  // each Sandbox's use by the view clock, for the Sandboxes list: made, last used, closed, calls and commands
  const sbId = call === "sandbox.create" ? o.ok && o.result.id : args.sandbox;
  if (sbId) {
    const at = (W.sbAt[sbId] ||= { calls: 0, execs: 0 });
    at.last = W.clock; at.calls = (at.calls || 0) + 1;
    if (call === "sandbox.exec") at.execs = (at.execs || 0) + 1;
    if (call === "sandbox.create") Object.assign(at, { made: W.clock, image: args.image || null });
    if (o.ok && call === "sandbox.close") at.closed = W.clock;
  }
  if (o.ok && (o.code === "Forked" || o.code === "Merged")) W.attrib["fork:" + o.result.branch] = n;

  // which terminal and which line: cli.js
  // a create that named no Sandbox (the simulator's) prints the one it made
  const named = call === "sandbox.create" && !args.name && o.ok ? { ...args, name: o.result.id } : args;
  const route = routeOf(call), text = cliOf(call, named, st.sh), dim = !!route.dim;
  if (route.at === "fs") {
    branch = args.branch || args.ref;
    (W.fsLog[branch] ||= []).push({ agent: n, text, out, t: seq, dim, calls, group });
    A.lastLoc = { kind: "fs", branch };
  } else if (call === "sandbox.mount") {
    if (o.ok) {
      A.ws = { sandbox: o.result.sandbox, path: o.result.path };
      if (st.as) W.names[st.as] = A.ws;
      const k = `${A.ws.sandbox}:${A.ws.path}`;
      W.panes[k] = { agent: n, born: seq, branch, lines: [{ dim, text, out, t: seq, calls, group }] };
      A.lastLoc = { kind: "ws", branch, ws: k };
    } else { W.hist.push({ agent: n, text, out, t: seq, calls, group }); A.lastLoc = { kind: "hist" }; }
  } else if (paneCall) {
    (W.panes[pane] ||= { agent: n, born: seq, lines: [] }).lines.push({ text, out, t: seq, calls, group, dim });
    if (call === "sandbox.unmount" && o.ok) {
      // when it left, so a view can fade it out even if it never drew it mounted
      Object.assign(W.panes[pane], { left: seq, branch: W.panes[pane].branch ?? branch });
      // the agent may still hold other Workspaces (a script's fan-out): it stays on the latest one
      const left = Object.keys(W.panes).filter((k) => k !== pane && W.panes[k].agent === n && (engWs(s, k) || {}).mounted).pop();
      if (left) { const i = left.indexOf(":"); A.ws = { sandbox: left.slice(0, i), path: left.slice(i + 1) }; A.lastLoc = { kind: "ws", branch: engWs(s, left).branch, ws: left }; }
      else { A.ws = null; A.lastLoc = { kind: "bench" }; }
      A.lastBranch = branch;
    } else A.lastLoc = { kind: "ws", branch, ws: pane };
  } else {
    W.hist.push({ agent: n, text, out, t: seq, calls, group, ...(dim ? { dim } : {}) });
    A.lastLoc = { kind: "hist" };
    branch = call === "branch.publish" ? args.branch : args.name;
  }
  A.lastT = W.clock;
  if (A.lastLoc.branch) A.lastBranch = A.lastLoc.branch;
  if (branch && s.branches[branch]) W.touched[branch] = W.clock;
  W.lastTab = route.at === "fs" || route.at === "workspace" || paneCall ? branch : "main";
}

/** The outcome of an agent's last call in a step, for its pose. */
export const outOf = (call, o, tick) => ({ call, code: o.code, ok: o.ok, exit: o.ok && o.result ? o.result.exitCode || 0 : 0, proc: call === "sandbox.exec" && !!(o.ok && o.result && o.result.process), tick });
/** Demo steps: a background start reads as "running", so use the step's code when it says so. */
export const outCode = (call, o, code, tick) => ({ ...outOf(call, o, tick), proc: code === "running" || (call === "sandbox.exec" && !!(o.ok && o.result && o.result.process)) });
