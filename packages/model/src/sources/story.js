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
//   { demo, ev?, ... }   one frame of a demo story (demoFrames)
//
// `env` gives the engine helpers the page or test has loaded:
//   live                 true on the live server (no rewind; commands really run)
//   simulateShell, liveCommand, execLines, scriptFor, diffTrees   (simulation_engine)
//   loaded(root)         whether a live tree is here yet (changedPaths)
//   onFiles(subject, files)  a demo read that names a file opens it
import { createView, newAgent, outCode, prepare, record } from "../attribution.js";
import { changedPaths, derive, rootsOf } from "../derive.js";
import { callsOf, nodeOf, outLines, outcome } from "../terminals.js";
import { cliOf } from "../cli.js";

/** A view for a story, with a terminal engine (`Engine`) for demo stories. */
export function storyView(engine, { lead = "main", demo = null, Engine = null } = {}) {
  const W = createView(engine, { lead });
  if (demo) {
    W.demo = { e: new Engine(engine, "website"), fs: {}, sb: {}, st: {}, active: "main", code: {} };
    if (demo.roster) W.demo.e.actor = "lead";
  }
  return derive(W);
}

/** Runs one story step and rederives the view. */
export async function runStep(W, st, env) {
  const before = rootsOf(W), known = new Set(Object.keys(W.nodes));
  W.last = null; W.check = null; W.tick = (W.tick || 0) + 1; // one tick per step: poses show this step's outcomes
  if (st.demo) { W.clock += 2; await runDemo(W, st, env); }
  else if (st.burst) { W.clock += 4; for (const e of st.burst) await runCall(W, e, env); W.lastTab = st.tab; }
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

// ------------------------------------------------------------------ demo stories
// A demo story (dsh/sim/demo.js) plays through the simulation engine's
// terminal (terminal.js Engine), so its outcomes are the engine's.
// dsh adds which agent made each call. An agent step is one Bash tool call:
// mount a Workspace in the Branch's shared Sandbox, run, commit, unmount.
// Each phase is one frame, in demo.js's own schedule.

/** Frames for a demo story; `fixture` is the Init files, `schedule` demo.js's. */
export function demoFrames(story, { lead, fixture, schedule }) {
  const escT = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const out = [{ a: lead, call: "project.init", args: { name: "website", files: fixture },
    cap: `<b>${escT(story.title)}</b> · a LayerFS demo story, played by dsh. Every call is made by an agent, and the UI shows who.`, w: 1 }];
  story.steps.forEach((st, i) => {
    const cap = st.note ? (st.act ? `<b>${escT(st.act)}</b> · ` : "") + escT(st.note) : null;
    const w = st.beat || !story.roster ? 1 : 0.55;
    const base = { demo: st, index: i };
    if (st.agent || st.burst) {
      const evs = schedule(st).filter((e) => e.phase !== "think");
      evs.forEach((ev, k) => out.push({ ...base, ev, a: ev.who, cap: k ? null : cap, last: k === evs.length - 1,
        w: ev.phase === "mount" ? 0.35 : w, label: `${ev.who} · ${ev.phase === "done" ? "commit + unmount" : ev.phase === "stop" ? "stop" : ev.phase === "mount" ? "mount" : ev.line}` }));
      return;
    }
    const who = st.ui === "agents" || st.milestone ? "dsh" : lead;
    const label = st.ui === "agents" ? `spawn ${st.agents.join(", ")} on ${st.branch}` : st.milestone ? `${st.milestone} ${st.pct}% · ${st.caption}`
      : st.ui ? `${st.ui} ${st.as || st.term}` : `${st.term === "history" ? "project" : st.term === "fs" ? "fs" : st.term}> ${st.lines[0]}${st.lines.length > 1 ? " …" : ""}`;
    out.push({ ...base, a: who, cap: st.milestone ? `<b>${escT(st.milestone)} ${st.pct}%</b> · ${escT(st.caption)}` : cap, last: true, label, w });
  });
  return out;
}

const LIFTED = new Set(["sandbox.create"]);
/** One frame of a demo story, run on the terminal engine; its records become
 * terminal lines, Workspace panes, agent locations and attribution. */
async function runDemo(W, fr, env) {
  const D = W.demo, e = D.e, st = fr.demo, n = fr.a, seq = ++W.seq, recs = [];
  // The engine creates a Sandbox inside a mount; dsh reports that create as
  // its own event, so it prints in the project terminal under the agent.
  const liftCreates = (rec) => {
    for (const c of rec.calls.filter((x) => x.call === "sandbox.create")) {
      W.hist.push({ agent: n, text: cliOf("sandbox.create", { ...c.args, name: c.args?.name ?? (c.outcome.ok ? c.outcome.result.id : undefined) }), out: outcome(c.call, c.outcome), t: seq, calls: callsOf({ calls: [c] }) });
      if (c.outcome.ok) { W.sbBy[c.outcome.result.id] = { made: n }; W.sbAt[c.outcome.result.id] = { made: W.clock, last: W.clock, image: c.args?.image || null, calls: 1, execs: 0 }; }
    }
    return rec;
  };
  const A = n === "dsh" ? null : (W.agents[n] ||= newAgent());
  const wsBranch = (b) => { const w = b && W.engine.s.sandboxes[b.sandbox] && W.engine.s.sandboxes[b.sandbox].workspaces[b.path]; return w ? w.branch : D.active; };
  const paneLine = (b, line) => { const k = `${b.sandbox}:${b.path}`; (W.panes[k] ||= { agent: n, born: seq, lines: [] }).lines.push({ ...line, t: seq }); return k; };
  const inPane = (b, rec, text, dim) => {
    const out = outLines(rec).filter((x) => !/^✓ created sb_/.test(x.t)); // the create printed in the project terminal
    const k = paneLine(b, { text, dim, out, calls: callsOf(rec, LIFTED) }), branch = wsBranch(b);
    W.panes[k].branch ??= branch;
    if (rec.unmounted) W.panes[k].left = seq;
    const at = (W.sbAt[b.sandbox] ||= { calls: 0, execs: 0 }); at.last = W.clock; at.calls++; if (rec.calls?.some((c) => c.call === "sandbox.exec")) at.execs++;
    A.lastLoc = rec.unmounted ? { kind: "bench" } : { kind: "ws", branch, ws: k }; A.lastBranch = branch; W.lastTab = branch; W.touched[branch] = W.clock;
  };
  let code = null;
  if (st.branch) D.active = st.branch;
  if (st.ui === "agents") {
    // dsh spawns the agents; they wait on this Branch's bench until they act
    for (const a of st.agents) {
      D.st[a] = { name: a, branch: st.branch, open: null, sticky: null, server: null };
      Object.assign((W.agents[a] ||= newAgent()), { lastLoc: { kind: "bench" }, lastT: W.clock, lastBranch: st.branch, spawned: W.tick });
    }
    code = "ok"; W.lastTab = st.branch;
  } else if (st.milestone) code = "ok";
  else if (fr.ev) {
    const ev = fr.ev, a = D.st[ev.who], b = ev.phase === "stop" ? a.server : a.open;
    let rec = null;
    if (ev.phase === "stop") rec = await e.agentStop(a);
    else if (ev.phase === "mount") {
      rec = liftCreates(await e.agentMount(a, st.on));
      if (rec.binding && !rec.reused) W.panes[`${rec.binding.sandbox}:${rec.binding.path}`] = { agent: n, born: seq, lines: [] };
      if (rec.binding) inPane(rec.binding, rec, rec.reused ? "reuse the kept Workspace" : `mount ${wsBranch(rec.binding)}`, true);
    } else if (ev.phase === "exec" && b) rec = await e.agentExec(a, ev.line);
    else if (ev.phase === "done" && b) rec = await e.agentFinish(a);
    if (rec && ev.phase !== "mount") inPane(b || rec.binding, rec, ev.phase === "done" ? `commit -m "${n}: ${ev.line}"` : ev.phase === "stop" ? "stop the server" : ev.line);
    if (rec) { recs.push(rec); if (!(ev.phase === "mount" && a.open)) code = rec.code; }
  } else if (st.ui === "open" || st.ui === "split") {
    const o = await e.openSandbox(D.active, st.ui === "split" ? D.sb[st.from].sandbox : null);
    liftCreates(o.rec);
    recs.push(o.rec);
    code = o.rec.calls.length ? o.rec.calls[o.rec.calls.length - 1].outcome.code : null;
    if (o.binding) {
      D.sb[st.as] = o.binding;
      W.panes[`${o.binding.sandbox}:${o.binding.path}`] = { agent: n, born: seq, lines: [] };
      inPane(o.binding, o.rec, `${st.ui === "split" ? "split" : "open"} ${D.active}`, true);
    }
  } else if (st.ui === "stop") {
    const b = D.sb[st.term], sb = W.engine.s.sandboxes[b.sandbox], rec = e.newRec();
    const proc = sb.procOrder.find((p) => sb.processes[p].path === b.path && sb.processes[p].status === "running");
    const o = await e.call(rec, "process.cancel", { sandbox: b.sandbox, process: proc });
    rec.lines.push({ t: o.ok ? `■ ${proc} stopped` : `✕ ${o.code}`, c: o.ok ? "info" : "err" });
    recs.push(rec); code = o.code; inPane(b, rec, `kill ${proc}`);
  } else {
    // typed lines: the project terminal (history), the fs terminal, or a Sandbox terminal
    for (const line of st.lines) {
      const at = D.active;
      const rec = st.term === "history" ? await e.history(line) : st.term === "fs" ? await e.fs(at, line, (D.fs[at] ||= {})) : await e.sandbox(D.sb[st.term], line);
      recs.push(rec);
      if (rec.calls.length) code = rec.calls[rec.calls.length - 1].outcome.code;
      const entry = { agent: n, text: line, out: outLines(rec), t: seq, calls: callsOf(rec), dim: /^(cat|read|ls|blame|log|branches|diff)\b/.test(line) };
      if (st.term === "history" || (st.term === "fs" && at === "main")) {
        W.hist.push(st.term === "fs" ? { ...entry, text: "fs " + line } : entry); A.lastLoc = { kind: "hist" }; W.lastTab = "main";
      } else if (st.term === "fs") {
        (W.fsLog[at] ||= []).push(entry); A.lastLoc = { kind: "fs", branch: at }; A.lastBranch = at; W.lastTab = at; W.touched[at] = W.clock;
      } else {
        const b = D.sb[st.term];
        inPane(b, rec, line);
        if (rec.calls.some((c) => c.call === "sandbox.unmount" && c.outcome.ok)) A.lastLoc = { kind: "bench" };
      }
      if (rec.forked) D.active = rec.forked;
      // a read that names a file opens it in that tab's Files view (blame on main)
      if (rec.files && env.onFiles) env.onFiles(W.engine.s.branches[rec.files.subject] ? rec.files.subject : "main", rec.files);
    }
  }
  if (A) A.lastT = W.clock;
  // the call that matters for the pose: a refusal, Commit, merge, publish or command, not the unmount after it
  const all = recs.flatMap((r) => r.calls), lastCall = all.filter((c) => !c.outcome.ok || ["Committed", "Merged", "Added"].includes(c.outcome.code) || c.call === "sandbox.exec").pop() || all[all.length - 1];
  if (A && lastCall) A.out = outCode(lastCall.call, lastCall.outcome, D.code[fr.index], W.tick);
  // attribution: each node a call created belongs to the agent that made it
  for (const rec of recs) for (const c of rec.calls) {
    const o = c.outcome, node = nodeOf(o);
    if (node) { W.attrib[node] = n; W.last = { agent: n, call: c.call, step: { sh: fr.ev && fr.ev.line }, o, node }; }
    if (o.ok && (o.code === "Forked" || o.code === "Merged")) { W.attrib["fork:" + o.result.branch] = n; W.touched[o.result.branch] = W.clock; }
    if (o.ok && c.call === "branch.publish") W.touched[c.args.branch] = W.clock;
  }
  if (!W.last && n !== "dsh") {
    const c = recs.flatMap((r) => r.calls).pop();
    if (c) W.last = { agent: n, call: c.call, step: { sh: fr.ev && fr.ev.line }, o: c.outcome, node: null };
  }
  // the step's outcome, checked against demo.js's expectation on its last frame
  if (code !== null) D.code[fr.index] = code;
  if (fr.last) {
    const expect = env.live && st.live ? st.live : st.expect, got = D.code[fr.index] ?? "(none)";
    W.check = { expect, code: got, ok: got === expect };
    (W.checks ||= []).push({ index: fr.index, ...W.check });
  }
}
