// The demo stories' tool calls, after the simulation engine's terminals (dsh/sim/demo.js):
// each export is one line typed at a terminal there, made of the same SDK
// calls, and prints what the terminal printed. A scenario step's bash `run`
// imports this file and awaits these in order (scenario.js).
//   history("fork checkout" | "fork header from C4" | "merge a b as c" | "publish b")
//   fs(branch, "write" | "edit" | "mkdir" | "blame", path, ...)   one Commit (or a read)
//   sandbox(name)    starts a Sandbox (sandbox.create) known to later calls as `name`
//   open(as, sandbox, branch), split(from, as)   a Workspace terminal: a new
//                    Workspace of the Branch in the Sandbox named `sandbox`, or a
//                    second one of `from`'s Branch in `from`'s Sandbox
//   term(as, line)   "commit [--force]", "unmount [--discard]", "stop", or a shell
//                    line (a trailing & starts a background process)
//   call(agent, sandbox, branch, line)   an agent's Bash tool call: a Workspace
//                    of its own of the Branch in the named Sandbox, mounted, run,
//                    committed and unmounted;
//                    after a Conflict it is kept and the agent's next call runs
//                    in it; a trailing & keeps it for the server, and "stop"
//                    ends the server.
//   closeAll()       closes every Sandbox sandbox(name) started (sandbox.close)
//   done()           closes the client; every run command ends with it
// What a later call needs (a terminal's Workspace, an agent's kept one, C<n>
// labels) is kept under the project's LayerFS home entry, which is removed
// with the project. Each call is attempted once: a refusal is printed, and an
// unexpected one shows in the step's outcomes, never retried.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const project = process.env.DSH_LAYERFS_PROJECT;
if (!project) { console.log("no LayerFS project in this conversation"); process.exit(1); }
// a scenario never touches a project it did not make
if (!project.startsWith("mock-")) { console.log(`✕ ${project} is not a scenario's project (mock-…): refused`); process.exit(1); }
const { LayerFS, isRefusal } = await import(process.env.DSH_LAYERFS_SDK);
const lf = await LayerFS.open(project);
let backend;
const op = () => (backend ??= import(process.env.DSH_LAYERFS_BACKEND).then(({ LayerFSBackend }) => LayerFSBackend.of(lf).daemon));
export const done = () => lf.close();

// ------------------------------------------------------------------ notes
const NOTES = join(process.env.DSH_LAYERFS_HOME, project, "demo-notes");
const note = (key) => { try { return JSON.parse(readFileSync(join(NOTES, `${key}.json`), "utf8")); } catch { return null; } };
function keep(key, value) {
  const file = join(NOTES, `${key}.json`);
  if (value === null) return rmSync(file, { force: true });
  mkdirSync(NOTES, { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value));
  renameSync(`${file}.tmp`, file);
}
/** C<n>: the n-th Commit these calls made, by time, as History numbers them. */
function label(id, time = Date.now()) {
  if (!id) return "?";
  if (!String(id).startsWith("12")) return "a Layer of main"; // not a Commit id
  const dir = join(NOTES, "commits");
  mkdirSync(dir, { recursive: true });
  try { time = Number(readFileSync(join(dir, id), "utf8")); } catch { writeFileSync(join(dir, id), String(time)); }
  const all = readdirSync(dir).filter((f) => !f.endsWith(".tmp")).map((f) => [Number(readFileSync(join(dir, f), "utf8")), f]);
  return `C${all.filter(([t, f]) => t < time || (t === time && f <= id)).length}`;
}
function idOf(ref) {
  const n = /^C(\d+)$/.exec(ref)?.[1];
  if (!n) return ref;
  const dir = join(NOTES, "commits");
  const all = readdirSync(dir).map((f) => [Number(readFileSync(join(dir, f), "utf8")), f]).sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return all[n - 1]?.[1] ?? ref;
}
const committed = (r) => label(r.commit?.id ?? r.head, r.commit?.time);

// ------------------------------------------------------------------ calls
// One attempt: LayerFS queues concurrent writers itself, so a call is never retried here.
const settle = (call) => call();
/** Runs a terminal line: a refusal is printed as the terminal did, anything else fails the call. */
async function line(work) {
  try { return await work(); } catch (error) {
    if (!error.code) { console.log(`✕ ${error.message}`); process.exitCode = 1; return null; }
    refused(error);
    return null;
  }
}
function refused(error) {
  console.log(`✕ ${String(error.message).startsWith(error.code) ? error.message : `${error.code}: ${error.message}`}`);
  for (const c of error.detail?.conflicts ?? []) {
    console.log(`  ${c.path}`);
    for (const h of c.hunks ?? []) {
      for (const t of h.ours ?? []) console.log(`    ours   ${h.line ?? ""}: ${t.trim()}`);
      for (const t of h.theirs ?? []) console.log(`    theirs ${h.line ?? ""}: ${t.trim()}`);
    }
  }
}
const abs = (path) => (path.startsWith("/") ? path : `/${path}`);
const lwwLines = (lww) => { if (lww?.length) console.log(`  last writer won ${lww.length} path(s): ${lww.slice(0, 4).map((x) => x.path ?? x).join(", ")}${lww.length > 4 ? ", …" : ""}`); };

export const history = (text) => line(async () => {
  const words = text.trim().split(/\s+/), [verb] = words;
  if (verb === "fork") {
    const [, name, from, ref] = words;
    const r = await settle(() => (from === "from" ? lf.branch.fork(name, idOf(ref)) : lf.branch.fork(name)));
    console.log(`✓ fork ${r.branch ?? name} from ${ref ?? "main"}`);
  } else if (verb === "merge") {
    const [, a, b, as, name] = words;
    if (as !== "as") throw new Error("usage: merge <a> <b> as <name>");
    const r = await settle(() => lf.branch.merge(a, b, name));
    console.log(`✓ merge ${a} + ${b} → ${name} · ${r.fastForward ? "fast-forward to" : "first Commit"} ${label(r.head)}`);
    lwwLines(r.lww);
  } else if (verb === "publish") {
    const r = await settle(() => lf.branch.publish(words[1]));
    console.log(r.kind === "Added" ? `✓ publish ${words[1]} → main · a new Layer${r.overwrote?.length ? ` · overwrote ${r.overwrote.length} Layer(s) of main` : ""}` : `= ${r.kind}`);
  } else throw new Error(`history: fork, merge or publish, not ${verb}`);
});

export const fs = (branch, verb, path, ...rest) => line(async () => {
  const p = abs(path);
  if (verb === "blame") {
    const r = await lf.fs.blame(branch, p);
    let last = null;
    for (const l of r.lines) {
      const who = l.commit === last ? "·" : String(l.commit).startsWith("12") ? `${label(l.commit)} ${l.message ?? ""}`.trim() : "init";
      last = l.commit;
      console.log(`${who.padEnd(28).slice(0, 28)} ${String(l.n).padStart(3)} │ ${l.text}`);
    }
    return console.log(`from ${r.versions} saved version(s) · fs.blame`);
  }
  const message = `${verb} ${p}`;
  const r = await settle(() => (verb === "write" ? lf.fs.write(branch, p, rest[0], message)
    : verb === "edit" ? lf.fs.edit(branch, p, rest[0], rest[1], message)
    : verb === "mkdir" ? lf.fs.mkdir(branch, p, message)
    : Promise.reject(new Error(`fs: write, edit, mkdir or blame, not ${verb}`))));
  console.log(r.kind === "Committed" ? `✓ ${verb} ${p} · ${committed(r)} on ${branch}` : `= ${r.kind}`);
});

// ------------------------------------------------------------------ Sandbox terminals
const termOf = (as) => { const t = note(`term-${as}`); if (!t) throw new Error(`no terminal ${as}`); return t; };
/** The number of the Sandbox `sandbox(name)` started. */
const sandboxOf = (name) => {
  const sb = note(`sandbox-${name}`);
  if (!sb) throw new Error(`no Sandbox named ${name}: a step starts it with sandbox("${name}") first`);
  return sb.sandbox;
};
/** A new Workspace of `branch` in the Sandbox numbered `sandbox`: `{ sandbox, path }`. */
const mount = (sandbox, branch) => settle(() => lf.workspace.mount(sandbox, branch));

export const sandbox = (name) => line(async () => {
  const sb = await lf.sandbox.create();
  keep(`sandbox-${name}`, sb);
  console.log(`● Sandbox ${sb.sandbox} started for ${name}`);
});
/** A note's Workspace, as the SDK takes it. */
const wsOf = (t) => ({ sandbox: t.sandbox, path: t.path });

export const open = (as, sandbox, branch) => line(async () => {
  const ws = await mount(sandboxOf(sandbox), branch);
  keep(`term-${as}`, { ...ws, branch, ran: [] });
  console.log(`● ${as}: Sandbox ${ws.sandbox} · mount ${branch} → ${ws.path}`);
});

export const split = (from, as) => line(async () => {
  const { branch, sandbox } = termOf(from);
  const ws = await mount(sandbox, branch);
  keep(`term-${as}`, { ...ws, branch, ran: [] });
  console.log(`● ${as}: a second Workspace of ${branch} · Sandbox ${ws.sandbox} → ${ws.path}`);
});

export const term = (as, text) => line(async () => {
  const t = termOf(as), cmd = text.trim(), [verb, flag] = cmd.split(/\s+/);
  if (verb === "commit") {
    const r = await commit(wsOf(t), t.ran.length ? `${as}: ${t.ran.join("; ")}` : `${as}: commit`, flag === "--force");
    if (!r.refused) keep(`term-${as}`, { ...t, ran: [] });
  } else if (verb === "unmount") {
    await settle(() => lf.workspace.unmount(wsOf(t), flag === "--discard"));
    keep(`term-${as}`, null);
    console.log(`✓ unmounted ${t.path} · ${as} closed`);
  } else if (verb === "stop") {
    for (const id of t.processes ?? []) {
      const r = await (await op()).process.cancel(id);
      console.log(`■ ${id} ${r.status}`);
    }
    keep(`term-${as}`, { ...t, processes: [] });
  } else {
    const r = await shell(wsOf(t), cmd);
    keep(`term-${as}`, { ...t, ran: [...t.ran, cmd], processes: [...(t.processes ?? []), ...(r.process ? [r.process] : [])] });
  }
});

/** A shell line in Workspace `ws`: exec, or a background process for a trailing &. */
async function shell(ws, cmd) {
  console.log(`$ ${cmd}`);
  const background = /&\s*$/.test(cmd);
  if (background) {
    const r = await (await op()).process.start(ws, cmd.replace(/&\s*$/, "").trim());
    console.log(`● ${r.process} running · ${ws.path} stays mounted while it runs`);
    return r;
  }
  const r = await lf.workspace.exec(ws, cmd);
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd();
  if (out) console.log(out);
  console.log(`[exit ${r.exitCode}]`);
  return r;
}

/** Commit, printed as the terminals did: a stale Workspace merges with the head first; a Conflict is returned as { refused }. */
async function commit(ws, message, force = false) {
  let r;
  try { r = await settle(() => lf.workspace.commit(ws, message, force)); } catch (error) {
    if (!isRefusal(error, "Conflict")) throw error;
    refused(error);
    console.log(error.detail?.markers ? "  remove every <<<<<<< ======= >>>>>>> block, then commit" : `  nothing committed · the merge is written into ${ws.path} with markers`);
    return { refused: error };
  }
  if (r.kind !== "Committed") { console.log("= nothing to commit"); return r; }
  console.log(`✓ commit ${committed(r)}${r.merged ? ` · was stale on ${label(r.merged.from)}, merged with the head ${label(r.merged.head)}` : ""}`);
  lwwLines(r.lww);
  return r;
}

// ------------------------------------------------------------------ agents
// Runs play at full speed: order comes from the scenario's waits, never from time.
export const call = (agent, sandbox, branch, text) => line(async () => {
  const st = note(`agent-${agent}`) ?? {}, cmd = text.trim();
  if (cmd === "stop") {
    if (!st.server) return console.log("no background process to stop");
    const { sandbox: sb, path, processes } = st.server;
    for (const id of processes) await (await op()).process.cancel(id);
    await settle(() => lf.workspace.unmount({ sandbox: sb, path }, true));
    keep(`agent-${agent}`, { ...st, server: null });
    return console.log(`■ stopped · unmounted ${path} · its uncommitted dev cache discarded`);
  }
  let ws = st.sticky;
  if (ws) console.log(`⟳ ${ws.path} · kept after the conflict`);
  else {
    ws = await mount(sandboxOf(sandbox), branch);
    console.log(`⟳ mount ${branch} in Sandbox ${ws.sandbox} → ${ws.path}`);
  }
  const r = await shell(ws, cmd);
  if (r.process) return keep(`agent-${agent}`, { ...st, sticky: null, server: { ...ws, processes: [r.process] } });
  const c = await commit(ws, `${agent}: ${cmd}`);
  if (c.refused) {
    keep(`agent-${agent}`, { ...st, sticky: ws });
    return console.log("  this Workspace is kept: the next call runs in it");
  }
  if (st.sticky) keep(`agent-${agent}`, { ...st, sticky: null });
  await settle(() => lf.workspace.unmount(ws));
  console.log(`  unmounted ${ws.path}`);
});

/** Closes each Sandbox sandbox(name) started; one that closed itself while idle is said so, any other refusal fails the call. */
export const closeAll = () => line(async () => {
  const names = existsSync(NOTES) ? readdirSync(NOTES).filter((f) => /^sandbox-.+\.json$/.test(f)).map((f) => f.slice(8, -5)).sort() : [];
  for (const name of names) {
    const { sandbox: n } = note(`sandbox-${name}`);
    try {
      const r = await lf.sandbox.close(n);
      console.log(`✓ Sandbox ${n} (${name}) ${r.kind.toLowerCase()}`);
    } catch (error) {
      if (!isRefusal(error, "NoSuchSandbox")) throw Object.assign(new Error(`${error.code ?? "Failed"}: ${error.message}`), { code: undefined });
      console.log(`= Sandbox ${n} (${name}) had already closed itself while idle`);
    }
    keep(`sandbox-${name}`, null);
  }
});
