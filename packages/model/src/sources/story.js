// Story source: plays scripted agent steps on an engine (the simulator or
// the live server) and records each call in the view. Every outcome (ids,
// Conflict, merges) comes from the engine, never from the story.
//
// Story steps:
//   { a, call, args }    an SDK call; `as` names what it made (a Sandbox or a
//                        Workspace) for later steps, and args.sandbox may use that name
//   { a, sh }            a shell command in the agent's Workspace (`ws` picks one by name)
//   { a, script, calls } one agent's script: several calls in one step, each an
//                        event whose `group` is the script's name
//   { a: "dsh", ... }    dsh itself: spawn agents, a burst of calls, a pause, a view
//
// `env` gives the engine helpers the page or test has loaded:
//   live                 true on the live server (no rewind; commands really run)
//   simulateShell, liveCommand, execLines, scriptFor, diffTrees   (simulation_engine)
//   loaded(root)         whether a live tree is here yet (changedPaths)
import { createView, newAgent, prepare, record } from "../attribution.js";
import { changedPaths, derive, rootsOf } from "../derive.js";

/** A view for a story. */
export function storyView(engine, { lead = "main" } = {}) {
  const W = createView(engine, { lead });
  return derive(W);
}

/** Runs one story step and rederives the view. */
export async function runStep(W, st, env) {
  const before = rootsOf(W), known = new Set(Object.keys(W.nodes));
  W.last = null; W.check = null; W.tick = (W.tick || 0) + 1; // one tick per step: poses show this step's outcomes
  if (st.burst) { W.clock += 4; for (const e of st.burst) await runCall(W, e, env); W.lastTab = st.tab; }
  else if (st.script) { W.clock += 4; for (const c of st.calls) await runCall(W, { a: st.a, group: st.script, ...c }, env); if (st.tab) W.lastTab = st.tab; }
  else if (st.call === "dsh.view") W.lastTab = st.tab;
  else if (st.call === "dsh.spawn") { W.clock += 4; for (const n of st.args.agents) (W.agents[n] ||= newAgent()).spawned = W.tick; }
  else if (st.call === "dsh.idle") W.clock += st.args.seconds;
  else if (st.replay) await st.replay(W, st);
  else { W.clock += 4; await runCall(W, st, env); }
  derive(W);
  W.newNodes = new Set(Object.keys(W.nodes).filter((id) => !known.has(id)));
  W.flash = env.diffTrees ? changedPaths(W, before, rootsOf(W), env) : {};
  return W;
}

/** One SDK call on the engine, with its timing envelope and the inline Node
 * script an agent would send. Live Init is the server's reset: a fresh
 * volume and an Init of the same fixture. */
export async function sdkCall(W, env, calls, call, args) {
  let o;
  if (env.live && call === "project.init") {
    const t0 = performance.now();
    o = await W.engine.reset();
    const s = W.engine.s;
    o.result = { kind: "Initialized", project: s.project.name, main: { headLayer: s.main.head } };
    o.timing = { totalMs: performance.now() - t0, reset: true };
  } else o = await W.engine.run(call, args);
  calls.push({ call, code: o.code, timing: o.timing, script: env.scriptFor ? env.scriptFor({ call, args }, (W.engine.s.project || {}).name || "website") : undefined });
  return o;
}

export async function runCall(W, st, env) {
  const p = prepare(W, st), calls = [];
  let s = W.engine.s, shOut = null, o;
  const { call, args, mine, bind } = p;
  if (st.sh) {
    // sim: the shell is simulated and its writes go to the call; live: the
    // command really runs in the Workspace (a trailing & starts a process).
    const r = env.live ? env.liveCommand(st.sh) : env.simulateShell(st.sh, mine, s.sandboxes[bind.sandbox]);
    shOut = r.out || null;
    if (r.refuse) o = { ok: false, code: "ShellRefused", refusal: { message: r.out.map((x) => x.t).join(" ") } };
    else if (env.live) { o = await sdkCall(W, env, calls, call, { ...args, command: r.command, background: r.background || undefined }); shOut = o.ok ? env.execLines(o.result) : []; }
    else o = await sdkCall(W, env, calls, call, { ...args, command: st.sh, writes: r.writes, output: r.out.map((x) => x.t).join("\n"), exitCode: r.code, background: r.background || undefined });
  } else o = await sdkCall(W, env, calls, call, args);
  s = W.engine.s; // live: the server answers with a new state object
  // live reads name a raw snapshot id: show the ref at its head instead, like the simulator
  if (env.live && call === "fs.read" && o.ok && s.branches[args.ref]) o.result.snapshot = `${args.ref} @ ${s.branches[args.ref].head || s.branches[args.ref].base}`;
  record(W, st, p, o, shOut, calls);
}
