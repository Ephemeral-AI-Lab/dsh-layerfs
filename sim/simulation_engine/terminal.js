// Command engine for the LayerFS terminal UI. Three CLIs, each line mapping to
// SDK calls through a backend (backend/sim.js), awaited:
//   fs       — file commands on one Branch (direct Store writes, no mount)
//   sandbox  — shell commands (each one sandbox.exec), commit, unmount
//   history  — branches / log / fork / publish / diff for the whole project
// Shell commands are simulated against the Workspace overlay.
(function (global) {
  "use strict";
  const M = typeof module !== "undefined" && module.exports ? require("./model.js") : global.LayerSim;
  const F = typeof module !== "undefined" && module.exports ? require("./files.js") : global.LayerFiles;

  // ---------------------------------------------------------------- tokenizer
  // Shell-like: quotes, backslash escapes, and the operators && | > >> &.
  function tokenize(s) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "&" && s[i + 1] === "&") { out.push({ op: "&&" }); i += 2; continue; }
      if (c === "&") { out.push({ op: "&" }); i++; continue; }
      if (c === "|") { out.push({ op: "|" }); i++; continue; }
      if (c === ">") { if (s[i + 1] === ">") { out.push({ op: ">>" }); i += 2; } else { out.push({ op: ">" }); i++; } continue; }
      let tok = "";
      while (i < s.length && !/\s/.test(s[i]) && !"&|>".includes(s[i])) {
        const ch = s[i];
        if (ch === '"' || ch === "'") {
          i++;
          while (i < s.length && s[i] !== ch) {
            if (ch === '"' && s[i] === "\\" && i + 1 < s.length) {
              const n = s[i + 1];
              if ('"\\$`'.includes(n)) { tok += n; i += 2; }
              else if (n === "n") { tok += "\n"; i += 2; }
              else { tok += "\\" + n; i += 2; }
            } else tok += s[i++];
          }
          i++;
        } else if (ch === "\\" && i + 1 < s.length) { tok += s[i + 1]; i += 2; }
        else tok += s[i++];
      }
      out.push({ t: tok });
    }
    return out;
  }
  const words = (toks) => toks.filter((t) => t.t !== undefined).map((t) => t.t);
  const abs = (p) => { if (!p || p === "." || p === "./") return "/"; let q = p.replace(/^\.\//, ""); q = q.startsWith("/") ? q : "/" + q; return q.length > 1 ? q.replace(/\/+$/, "") : q; };
  const rel = (p) => p.replace(/^\//, "") || ".";
  const L = (t, c = "") => ({ t, c });
  const refusal = (o) => L(`✕ ${o.code}  ${o.refusal.message}`, "err");
  const short = (b) => `${b.sandbox}:ws/${b.path.split("/").pop()}`;

  function diffLines(items, max = 40) {
    const out = items.slice(0, max).map((d) => L(`${d.kind[0]} ${d.path}${d.type === "dir" ? "/" : ""}${d.kind === "Modified" && !d.content && d.identity ? "  (identity only)" : ""}`, d.kind === "Added" ? "add" : d.kind === "Removed" ? "del" : "mod"));
    if (items.length > max) out.push(L(`… ${items.length - max} more`, "dim"));
    if (!items.length) out.push(L("(no differences)", "dim"));
    return out;
  }
  function hunkLines(hunks, max = 60) {
    const out = [];
    hunks.forEach((h, i) => { if (i < max) out.push(L(`${h.op === " " ? " " : h.op} ${h.text}`, h.op === "+" ? "add" : h.op === "-" ? "del" : "dim")); });
    if (hunks.length > max) out.push(L(`… ${hunks.length - max} more lines`, "dim"));
    return out;
  }
  function publication(o) {
    if (!o.ok) return refusal(o);
    const r = o.result;
    if (r.kind === "UpToDate") return L("= UpToDate · nothing changed", "dim");
    const parent = r.merged && !r.displacedHead ? r.merged.head : r.capturedHead;
    return L(`✓ Committed ${r.head} · parent ${parent || "none (Branch base)"} · root ${r.root}${r.displacedHead ? ` · displaced ${r.displacedHead}` : ""}`, "ok");
  }
  // Conflict listing shared by commit, merge and publish.
  function conflictLines(list) {
    return list.map((c) => L(`  C ${rel(c.path).padEnd(22)} ${c.kind}${c.blocks > 1 ? ` · ${c.blocks} blocks` : c.blocks === 1 ? " · 1 block" : ""}`, "del"));
  }
  const lwwLines = (list) => list.map((d) => L(`  = last-writer-wins: ${rel(d.path)} ← ${d.deleted ? "deleted by " : ""}${d.kept}  (rule ${d.rule})`, "dim"));

  // ---------------------------------------------------------------- engine
  class Engine {
    constructor(sim, project) { this.sim = sim; this.project = project; }
    async call(rec, name, args) {
      // actor: who is typing (a demo label); agent calls pass their own.
      if (this.actor && args.message === undefined && /^(fs\.(write|edit|mkdir|rm|cp|mv|apply)|branch\.merge)$/.test(name)) args = { ...args, message: `${this.actor}: ${name}` };
      const outcome = await this.sim.run(name, args);
      rec.calls.push({ call: name, args, outcome, script: M.scriptFor({ call: name, args }, this.project) });
      return outcome;
    }
    newRec() { return { lines: [], calls: [] }; }

    // ------------------------------------------------------------ fs
    // state: { batch: null | Change[], heredoc: null | { path, buf } }
    fsPrompt(branch, state) {
      if (state.heredoc) return "> ";
      if (state.batch) return "apply> ";
      return branch === "main" ? "fs:main (read-only)> " : `fs:${branch}> `;
    }
    async fs(branch, line, state) {
      const rec = this.newRec();
      if (state.heredoc) {
        if (line.trim() === "EOF") {
          const { path, buf } = state.heredoc;
          state.heredoc = null;
          await this.fsChange(rec, branch, state, { kind: "write", path, content: buf.join("\n") });
        } else state.heredoc.buf.push(line);
        return rec;
      }
      const toks = tokenize(line);
      const w = words(toks);
      if (!w.length) return rec;
      const [cmd, ...a] = w;
      const flags = new Set(a.filter((x) => /^-\w+$/.test(x)));
      const args = a.filter((x) => !/^-\w+$/.test(x));
      const has = (f) => [...flags].some((x) => x.includes(f));
      const ro = branch === "main";
      const ref = branch;
      switch (cmd) {
        case "help":
          rec.lines.push(L("read:   ls [path] · cat <path> · stat <path> · grep <text> [path] · diff <a>[@C#] <b>[@C#]", "dim"));
          rec.lines.push(L("view:   blame <path>[@ref] · open <path>[@ref]   (ref: C#, L#, main or a Branch; opens the Files pane)", "dim"));
          rec.lines.push(L("write:  write <path> <<EOF … EOF · edit <path> <old> <new> · cp · mv · mkdir [-p] · rm [-r]", "dim"));
          rec.lines.push(L("batch:  apply, then write/edit/cp/mv/mkdir/rm lines, then done (or abort): one Commit", "dim"));
          return rec;
        case "ls": {
          const o = await this.call(rec, "fs.list", { ref, path: abs(args[0]) });
          if (!o.ok) rec.lines.push(refusal(o));
          else rec.lines.push(L(o.result.items.map((i) => i.name + (i.type === "dir" ? "/" : "")).join("  ") || "(empty)"));
          return rec;
        }
        case "cat": {
          if (!args[0]) { rec.lines.push(L("usage: cat <path>", "err")); return rec; }
          const [p, c] = args[0].split("@");
          const o = await this.call(rec, "fs.read", { ref, path: abs(p), commit: c });
          if (!o.ok) rec.lines.push(refusal(o)); else for (const t of o.result.text.split("\n")) rec.lines.push(L(t));
          return rec;
        }
        case "stat": {
          const o = await this.call(rec, "fs.stat", { ref, path: abs(args[0]) });
          rec.lines.push(o.ok ? L(`${o.result.type} · inode ${o.result.inode} · ${o.result.size} B · at ${o.result.snapshot}`) : refusal(o));
          return rec;
        }
        case "grep": {
          if (!args[0]) { rec.lines.push(L("usage: grep <text> [path]", "err")); return rec; }
          const o = await this.call(rec, "fs.grep", { ref, pattern: args[0], path: abs(args[1]) });
          if (!o.ok) rec.lines.push(refusal(o));
          else if (!o.result.items.length) rec.lines.push(L("(no matches)", "dim"));
          else for (const m of o.result.items) rec.lines.push(L(`${m.path}:${m.line}: ${m.text}`));
          return rec;
        }
        case "diff": {
          if (args.length < 2) { rec.lines.push(L("usage: diff <path>[@C#] <path>[@C#]", "err")); return rec; }
          const sel = (s) => { const [p, c] = s.split("@"); return { path: abs(p), commit: c || undefined }; };
          const o = await this.call(rec, "fs.diff_files", { ref, left: sel(args[0]), right: sel(args[1]) });
          if (!o.ok) rec.lines.push(refusal(o));
          else if (o.result.contentEqual) rec.lines.push(L(`= equal content · inodes ${o.result.left.inode} ${o.result.sameInode ? "=" : "≠"} ${o.result.right.inode}`, "info"));
          else rec.lines.push(...hunkLines(o.result.hunks));
          return rec;
        }
        case "blame": {
          if (!args[0]) { rec.lines.push(L("usage: blame <path>[@ref]", "err")); return rec; }
          const [p, at] = args[0].split("@"), at2 = at || branch, path = abs(p);
          if (this.sim.live) return this.blameLive(rec, at2, path);
          // Simulator attribution over its saved versions; live uses fs.blame.
          if (at2 !== "main" && this.sim.s.branches[at2]) await this.call(rec, "branch.list_commits", { branch: at2 });
          for (const v of F.chainOf(this.sim, at2)) {
            const o = await this.call(rec, "fs.read", { ref: branch, path, commit: v.id });
            if (!o.ok) break;
          }
          const b = F.blame(this.sim, at2, path);
          if (!b) { rec.lines.push(L(`✕ NoSuchPath  ${path} does not exist at ${at2}`, "err")); return rec; }
          let last = null;
          const who = (id) => (this.sim.s.commits[id] && this.sim.s.commits[id].message) || "";
          const messages = b.lines.some((ln) => who(ln.origin.id));
          for (const ln of b.lines) {
            const id = ln.origin.id, chip = id === last ? "  ·" + (messages ? "     " : "") : id.padEnd(3) + (messages ? " " + who(id).padEnd(4) : "");
            last = id;
            rec.lines.push(L(`${chip}  ${String(ln.n).padStart(3)} │ ${ln.text}`));
          }
          rec.lines.push(L(`composed from ${b.versions} saved version${b.versions === 1 ? "" : "s"} · fs.blame`, "dim"));
          rec.files = { subject: at2, path, mode: "blame" };
          return rec;
        }
        case "open": {
          if (!args[0]) { rec.lines.push(L("usage: open <path>[@ref]", "err")); return rec; }
          const [p, at] = args[0].split("@");
          rec.open = { subject: at || branch, path: abs(p), mode: "view" };
          rec.lines.push(L(`→ ${abs(p)} at ${at || branch} opened in the Files pane`, "dim"));
          return rec;
        }
        case "apply":
          if (ro) { rec.lines.push(L("✕ ReadOnly  main changes only through publish", "err")); return rec; }
          state.batch = [];
          rec.lines.push(L("batch open: queue write/edit/cp/mv/mkdir/rm, then done (or abort)", "dim"));
          return rec;
        case "abort":
          if (!state.batch) { rec.lines.push(L("no batch open", "dim")); return rec; }
          rec.lines.push(L(`batch discarded (${state.batch.length} change${state.batch.length === 1 ? "" : "s"})`, "dim"));
          state.batch = null; return rec;
        case "done": {
          if (!state.batch) { rec.lines.push(L("no batch open", "dim")); return rec; }
          const changes = state.batch; state.batch = null;
          if (!changes.length) { rec.lines.push(L("batch was empty", "dim")); return rec; }
          this.fsPublish(rec, branch, await this.call(rec, "fs.apply", { branch, changes }));
          return rec;
        }
        case "write": {
          if (!args[0]) { rec.lines.push(L("usage: write <path> <<EOF … EOF", "err")); return rec; }
          if (ro) { rec.lines.push(L("✕ ReadOnly  main changes only through publish", "err")); return rec; }
          // `write p <<EOF` arrives as words ["p", "<<EOF"]; `write p "text"` carries the content inline
          if (args[1] && args[1].startsWith("<<")) { state.heredoc = { path: abs(args[0]), buf: [] }; return rec; }
          if (args[1] === undefined) { rec.lines.push(L("usage: write <path> <<EOF … EOF   or   write <path> \"text\"", "err")); return rec; }
          await this.fsChange(rec, branch, state, { kind: "write", path: abs(args[0]), content: args[1] });
          return rec;
        }
        case "edit":
          if (args.length < 3) { rec.lines.push(L('usage: edit <path> "<old>" "<new>"', "err")); return rec; }
          await this.fsChange(rec, branch, state, { kind: "edit", path: abs(args[0]), oldText: args[1], newText: args[2], all: undefined });
          return rec;
        case "mkdir":
          if (!args[0]) { rec.lines.push(L("usage: mkdir [-p] <path>", "err")); return rec; }
          await this.fsChange(rec, branch, state, { kind: "mkdir", path: abs(args[0]), recursive: has("p") || undefined });
          return rec;
        case "rm":
          if (!args[0]) { rec.lines.push(L("usage: rm [-r] <path>", "err")); return rec; }
          await this.fsChange(rec, branch, state, { kind: "remove", path: abs(args[0]), recursive: has("r") || undefined });
          return rec;
        case "cp": case "mv":
          if (args.length < 2) { rec.lines.push(L(`usage: ${cmd} <from> <to>`, "err")); return rec; }
          await this.fsChange(rec, branch, state, { kind: cmd, from: abs(args[0]), to: abs(args[1]), recursive: cmd === "cp" && has("r") ? true : undefined });
          return rec;
        default:
          rec.lines.push(L(`unknown fs command: ${cmd} · type help`, "err"));
          return rec;
      }
    }
    async fsChange(rec, branch, state, change) {
      if (branch === "main") { rec.lines.push(L("✕ ReadOnly  main changes only through publish", "err")); return; }
      for (const k of Object.keys(change)) if (change[k] === undefined) delete change[k];
      if (state.batch) {
        state.batch.push(change);
        rec.lines.push(L(`+ queued ${change.kind} ${change.path || change.from + " → " + change.to} (${state.batch.length})`, "dim"));
        return;
      }
      const map = { write: ["fs.write", { path: change.path, content: change.content }], edit: ["fs.edit", { path: change.path, oldText: change.oldText, newText: change.newText, all: change.all }],
        mkdir: ["fs.mkdir", { path: change.path, recursive: change.recursive }], remove: ["fs.rm", { path: change.path, recursive: change.recursive }],
        cp: ["fs.cp", { from: change.from, to: change.to, recursive: change.recursive }], mv: ["fs.mv", { from: change.from, to: change.to }] };
      const [call, args] = map[change.kind];
      for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];
      this.fsPublish(rec, branch, await this.call(rec, call, { branch, ...args }));
    }
    // Blame from the SDK (live backend): each line's last Commit and message.
    async blameLive(rec, at, path) {
      const o = await this.call(rec, "fs.blame", { ref: at, path });
      if (!o.ok) { rec.lines.push(refusal(o)); return rec; }
      const messages = o.result.lines.some((ln) => ln.message);
      let last = null;
      for (const ln of o.result.lines) {
        const id = String(ln.commit), chip = id === last ? "  ·" + (messages ? "     " : "") : id.padEnd(3) + (messages ? " " + (ln.message || "") : "");
        last = id;
        rec.lines.push(L(`${chip}  ${String(ln.n).padStart(3)} │ ${ln.text}`));
      }
      rec.lines.push(L(`from ${o.result.versions} saved version${o.result.versions === 1 ? "" : "s"} · fs.blame`, "dim"));
      rec.files = { subject: at, path, mode: "blame" };
      return rec;
    }
    // An fs Commit moves the head past every live mount of the Branch.
    fsPublish(rec, branch, o) {
      rec.lines.push(publication(o));
      if (!o.ok || o.result.kind !== "Committed") return;
      const s = this.sim.s;
      for (const key of this.sim.liveMountsOf(branch)) {
        const [sb, path] = key.split(":"), ws = s.sandboxes[sb].workspaces[path];
        rec.lines.push(L(`! ${key} is now stale (mounted ${ws.baseCommit || ws.baseLayer}); its commit will merge with ${o.result.head}`, "warn"));
      }
    }

    // ------------------------------------------------------------ sandbox
    // Opening a Sandbox terminal always mounts a new Workspace.
    async openSandbox(branch, sandboxId) {
      const rec = this.newRec();
      let sb = sandboxId;
      if (!sb) {
        const o = await this.call(rec, "sandbox.create", {});
        if (!o.ok) { rec.lines.push(refusal(o)); return { rec }; }
        sb = o.result.id;
        rec.lines.push(L(`✓ created ${sb}`, "info"));
      }
      const m = await this.call(rec, "sandbox.mount", { sandbox: sb, branch });
      if (!m.ok) { rec.lines.push(refusal(m)); return { rec }; }
      rec.lines.push(L(`✓ mounted ${m.result.branch} @ ${m.result.base} at ${sb}:${m.result.path}`, "info"));
      rec.lines.push(L("type shell commands (each runs via sandbox.exec) · commit · unmount", "dim"));
      return { rec, binding: { sandbox: sb, path: m.result.path } };
    }
    sandboxPrompt(b) { return `${b.agent ? b.agent + " · " : ""}${b.sandbox}:${b.path.replace("/workspaces/", "ws/")} $ `; }
    async sandbox(b, line) {
      const rec = this.newRec();
      const t = line.trim();
      if (!t) return rec;
      const verb = t.split(/\s+/)[0];
      if (verb === "help") { rec.lines.push(L("<shell command>       run it in this Workspace via sandbox.exec (append & for a server)", "dim"), L("commit [--force]      save to the Branch head; a stale Workspace merges first (conflict: markers written, nothing committed)", "dim"), L("                      --force: overwrite, the Workspace's files as they are, displacing a newer head", "dim"), L("unmount [--discard]   release the Workspace and close this terminal; --discard drops uncommitted changes", "dim")); return rec; }
      if (verb === "commit") {
        const rest = t.split(/\s+/).slice(1);
        if (rest.some((x) => x !== "--force")) { rec.lines.push(L("usage: commit [--force]", "err")); return rec; }
        const force = rest.includes("--force");
        const o = await this.call(rec, "sandbox.commit", force ? { sandbox: b.sandbox, path: b.path, force } : { sandbox: b.sandbox, path: b.path });
        rec.lines.push(publication(o));
        if (!o.ok && o.code === "Conflict") {
          const r = o.refusal;
          rec.lines.push(...conflictLines(r.conflicts));
          if (r.markers) rec.lines.push(L("  remove every <<<<<<< ======= >>>>>>> block, then commit", "dim"));
          else {
            const applied = (r.written || []).filter((p) => !r.conflicts.some((c) => c.path === p));
            if (applied.length) rec.lines.push(L(`  ↻ applied from ${r.head}: ${applied.map(rel).join(", ")}`, "dim"));
            rec.lines.push(...lwwLines(r.lww));
            rec.lines.push(L(`  this Workspace is now on ${r.head} with markers written · fix them, then commit`, "dim"));
          }
          rec.conflicts = r.conflicts.length;
        }
        if (o.ok && o.result.merged) {
          const m = o.result.merged;
          rec.lines.push(L(`  ⇣ merged with ${m.head} (Workspace was on ${m.from})${m.lww.length ? ` · ${m.lww.length} last-writer-wins` : ""}`, "info"));
          rec.lines.push(...lwwLines(m.lww));
        }
        if (o.ok) rec.conflicts = 0;
        if (o.ok && o.result.displacedHead) rec.lines.push(L(`! ${o.result.head} jumps from ${o.result.capturedHead || "the fork point"} over ${o.result.displacedHead}: ${o.result.displacedHead} stays stored but is no longer an ancestor of the head`, "warn"));
        return rec;
      }
      if (verb === "unmount") {
        const rest = t.split(/\s+/).slice(1);
        if (rest.some((x) => x !== "--discard")) { rec.lines.push(L("usage: unmount [--discard]", "err")); return rec; }
        const o = await this.call(rec, "sandbox.unmount", rest.length ? { sandbox: b.sandbox, path: b.path, discard: true } : { sandbox: b.sandbox, path: b.path });
        if (!o.ok) {
          rec.lines.push(refusal(o));
          if (o.code === "Dirty") rec.lines.push(L(`  ${o.refusal.changed.slice(0, 6).map(rel).join(", ")}${o.refusal.changed.length > 6 ? " …" : ""} · commit them, or unmount --discard`, "dim"));
          return rec;
        }
        const d = o.result.discardedUncommitted;
        rec.lines.push(L(`✓ unmounted${d.length ? ` · discarded ${d.length} uncommitted change${d.length === 1 ? "" : "s"}` : ""}`, d.length ? "warn" : "ok"));
        rec.closed = true;
        return rec;
      }
      // Anything else is a shell command for this Workspace.
      const command = t;
      const ws = this.sim.s.sandboxes[b.sandbox] && this.sim.s.sandboxes[b.sandbox].workspaces[b.path];
      if (!ws || !ws.mounted) { rec.lines.push(L("✕ NotMounted  this Workspace is gone", "err")); return rec; }
      const sh = this.shell(command, ws, b);
      if (sh.refuse) { rec.lines.push(...sh.out); return rec; }
      const o = await this.call(rec, "sandbox.exec", sh.args);
      rec.lines.push(...(sh.out || (o.ok ? execLines(o.result) : [])));
      if (!o.ok) rec.lines.push(refusal(o));
      else if (o.result.process) rec.lines.push(L(`● running in background as ${o.result.process}`, "info"));
      else rec.lines.push(L(`[exit ${o.result.exitCode}]`, o.result.exitCode ? "warn" : "ok"));
      return rec;
    }

    // The arguments of sandbox.exec for one command: the simulated writes and
    // output (simulator backend), or the real command (live backend).
    shell(command, ws, b) {
      if (this.sim.simulated) {
        const sh = simulateShell(command, ws, this.sim.s.sandboxes[b.sandbox]);
        if (sh.refuse) return sh;
        return { out: sh.out, args: { sandbox: b.sandbox, path: b.path, command, writes: sh.writes, output: sh.out.map((x) => x.t).join("\n"), exitCode: sh.code, background: sh.background || undefined } };
      }
      const run = liveCommand(command);
      if (run.refuse) return run;
      return { out: null, args: { sandbox: b.sandbox, path: b.path, command: run.command, background: run.background || undefined } };
    }

    // ------------------------------------------------------------ agents
    // Agents own no Sandbox and no Workspace. Each Branch has one shared
    // Sandbox (its execution environment, with one localhost), and every tool
    // call mounts a Workspace of its own in it:
    //   mount  -> run the command -> commit -> unmount.
    // The phases are separate calls so overlapping tool calls really overlap.
    // st: { name, branch, open, sticky, server }   (bindings { sandbox, path })
    //   open:   the Workspace of the call in progress
    //   sticky: a Workspace kept after a Conflict; the next call runs in it
    //   server: a Workspace kept for a background process (`cmd &`)
    async sandboxFor(rec, branch) {
      this.branchSandbox ||= {};
      const known = this.branchSandbox[branch], sb = known && this.sim.s.sandboxes[known];
      if (sb && !sb.closed) return known;
      const o = await this.call(rec, "sandbox.create", {});
      return (this.branchSandbox[branch] = o.result.id);
    }
    async agentMount(st, branch) {
      const rec = this.newRec(), s = this.sim.s;
      if (st.open) { rec.lines.push(L("✕ the previous call has not finished", "err")); rec.code = "busy"; return rec; }
      if (st.sticky) {
        const b = st.sticky, w = s.sandboxes[b.sandbox].workspaces[b.path];
        rec.lines.push(L(`⟳ ${short(b)} · kept after the conflict · on ${w.baseCommit || w.baseLayer}`, "warn"));
        st.open = { ...b }; rec.binding = b; rec.reused = true; rec.code = "Reused";
        return rec;
      }
      const target = branch || st.branch, sandbox = await this.sandboxFor(rec, target);
      const m = await this.call(rec, "sandbox.mount", { sandbox, branch: target });
      if (!m.ok) { rec.lines.push(refusal(m)); rec.code = m.code; return rec; }
      const b = { sandbox, path: m.result.path };
      rec.lines.push(L(`⟳ mount ${m.result.branch} @ ${m.result.base} → ${short(b)}`, "dim"));
      st.open = { ...b }; rec.binding = b; rec.code = m.code;
      return rec;
    }
    async agentExec(st, line) {
      const rec = this.newRec(), t = line.trim(), s = this.sim.s, b = st.open;
      if (!b) { rec.code = "none"; return rec; }
      const ws = s.sandboxes[b.sandbox].workspaces[b.path];
      const sh = this.shell(t, ws, b);
      st.open.command = t;
      if (sh.refuse) { rec.lines.push(...sh.out); rec.code = "refused"; return rec; }
      const o = await this.call(rec, "sandbox.exec", sh.args);
      rec.lines.push(...(sh.out || (o.ok ? execLines(o.result) : [])));
      if (o.ok && o.result.process) {
        rec.lines.push(L(`● ${o.result.process} running · ${short(b)} stays mounted while it runs`, "info"));
        st.server = { sandbox: b.sandbox, path: b.path }; st.open = null;
        rec.code = "running"; rec.event = { kind: "server" }; rec.done = true;
        return rec;
      }
      rec.lines.push(L(`[exit ${o.result.exitCode}]`, o.result.exitCode ? "warn" : "ok"));
      rec.code = o.code;
      return rec;
    }
    // Stops the agent's background process and releases its Workspace.
    async agentStop(st) {
      const rec = this.newRec(), s = this.sim.s, b = st.server;
      if (!b) { rec.lines.push(L("no background process to stop", "dim")); rec.code = "none"; rec.done = true; return rec; }
      const sb = s.sandboxes[b.sandbox];
      for (const pid of sb.procOrder) if (sb.processes[pid].path === b.path && sb.processes[pid].status === "running") await this.call(rec, "process.cancel", { sandbox: b.sandbox, process: pid });
      const o = await this.call(rec, "sandbox.unmount", { sandbox: b.sandbox, path: b.path, discard: true });
      const d = o.ok ? o.result.discardedUncommitted.length : 0;
      rec.lines.push(L(`■ stopped · unmounted${d ? ` · discarded ${d} uncommitted (dev cache)` : ""}`, "info"));
      st.server = null; rec.code = o.code; rec.event = { kind: "stopped" }; rec.done = true; rec.unmounted = b;
      return rec;
    }
    // Mount and run (or stop) in one go: used by bursts and tests.
    async agentStart(st, line, branch) {
      if (line.trim() === "stop") return await this.agentStop(st);
      const m = await this.agentMount(st, branch);
      if (!st.open) return { ...m, done: true };
      const x = await this.agentExec(st, line);
      return { ...x, lines: [...m.lines, ...x.lines], calls: [...m.calls, ...x.calls], binding: m.binding };
    }
    async agentFinish(st) {
      const rec = this.newRec(), b = st.open;
      if (!b) { rec.code = "none"; return rec; }
      st.open = null;
      rec.binding = { sandbox: b.sandbox, path: b.path };
      const o = await this.call(rec, "sandbox.commit", { sandbox: b.sandbox, path: b.path, message: `${st.name}: ${b.command}` });
      rec.code = o.code;
      if (!o.ok) {
        rec.lines.push(refusal(o));
        if (o.code === "Conflict") {
          const r = o.refusal;
          rec.lines.push(...conflictLines(r.conflicts));
          const applied = (r.written || []).filter((p) => !r.conflicts.some((c) => c.path === p));
          if (applied.length) rec.lines.push(L(`  ↻ applied from ${r.head}: ${applied.map(rel).join(", ")}`, "dim"));
          rec.lines.push(L(r.markers ? "  remove every <<<<<<< ======= >>>>>>> block, then commit" : `  nothing committed · this Workspace is kept on ${r.head} with markers · the next call runs in it`, "dim"));
        }
        st.sticky = rec.binding; rec.event = { kind: "conflict", with: o.refusal.markers ? null : o.refusal.head, from: o.refusal.base };
        return rec;
      }
      const r = o.result;
      const u = await this.call(rec, "sandbox.unmount", { sandbox: b.sandbox, path: b.path });
      if (r.kind === "UpToDate") rec.lines.push(L(`= nothing to commit${u.ok ? " · unmounted" : ""}`, "dim"));
      else rec.lines.push(L(`✓ commit ${r.head}${r.merged ? ` · was stale on ${r.merged.from}, merged with ${r.merged.head}` : ""}${u.ok ? " · unmounted" : ""}`, "ok"));
      if (r.merged) rec.lines.push(...lwwLines(r.merged.lww));
      st.sticky = null;
      if (u.ok) rec.unmounted = rec.binding;
      rec.event = { kind: r.kind !== "Committed" ? "uptodate" : r.merged && r.merged.lww.length ? "lww" : r.merged ? "merged" : "commit", head: r.head, with: r.merged ? r.merged.head : null, from: r.merged ? r.merged.from : null };
      return rec;
    }
    // A whole tool call: start, then finish.
    async agentCall(st, line, branch) {
      const a = await this.agentStart(st, line, branch);
      if (a.done || !st.open) return a;
      const f = await this.agentFinish(st);
      return { lines: [...a.lines, ...f.lines], calls: [...a.calls, ...f.calls], code: f.code, event: f.event, exit: a.code };
    }

    // ------------------------------------------------------------ history
    async history(line) {
      const rec = this.newRec();
      const w = words(tokenize(line));
      if (!w.length) return rec;
      const [cmd, ...a] = w;
      const s = this.sim.s;
      switch (cmd) {
        case "help":
          rec.lines.push(L("branches · log <branch|main> · fork <name> [from <branch|main|C#>] · diff <a> <b>", "dim"));
          rec.lines.push(L("merge <a> <b> as <c>   new Branch c = a + b (either may be main); a conflict is listed and nothing is created", "dim"));
          rec.lines.push(L("publish <branch>       replace main's files with the Branch head (overwrite only)", "dim"));
          return rec;
        case "branches": {
          const o = await this.call(rec, "project.list_branches", {});
          rec.lines.push(L(`main  ${s.main.head}  (read-only main line)`, "info"));
          for (const b of o.result.items) rec.lines.push(L(`${b.name}  ${b.head || "—"}  base ${b.base}${b.mountedBy.length ? `  ⛓ ${b.mountedBy.join(", ")}` : ""}`));
          return rec;
        }
        case "log": {
          const ref = a[0];
          if (!ref) { rec.lines.push(L("usage: log <branch|main>", "err")); return rec; }
          if (ref === "main") {
            const o = await this.call(rec, "main.list_layers", {});
            for (const l of o.result.items) rec.lines.push(L(`${l.id}  root ${l.root}  ${l.sourceCommit ? `from ${l.sourceBranch} ${l.sourceCommit}` : "project.init"}${l.id === s.main.head ? "  ← head" : ""}`));
            return rec;
          }
          const o = await this.call(rec, "branch.list_commits", { branch: ref });
          if (!o.ok) { rec.lines.push(refusal(o)); return rec; }
          if (!o.result.items.length) rec.lines.push(L(`no Commits yet · base ${s.branches[ref].base}`, "dim"));
          o.result.items.forEach((c, i) => rec.lines.push(L(`${c.id}  parent ${c.parent || "—"}  root ${c.root}  ${c.via}${i === 0 ? "  ← head" : ""}`)));
          const displaced = Object.values(s.commits).filter((c) => c.branch === ref && !o.result.items.some((x) => x.id === c.id));
          for (const c of displaced) rec.lines.push(L(`${c.id}  displaced by ${c.displacedBy || "a later Commit"} · still readable by id`, "warn"));
          return rec;
        }
        case "fork": {
          const name = a[0];
          if (!name) { rec.lines.push(L("usage: fork <name> [from <branch|main|C#>]", "err")); return rec; }
          const from = a[1] === "from" ? a[2] : "main";
          let o;
          if (!from || from === "main") o = await this.call(rec, "main.fork", { name });
          else if (/^C\d+$/.test(from)) {
            const c = s.commits[from];
            if (!c) { rec.lines.push(L(`✕ NoSuchCommit  ${from}`, "err")); return rec; }
            o = await this.call(rec, "branch.fork", { branch: c.branch, name, fromCommit: from });
          } else o = await this.call(rec, "branch.fork", { branch: from, name });
          if (!o.ok) { rec.lines.push(refusal(o)); return rec; }
          rec.lines.push(L(`✓ forked ${name} · base ${o.result.base}${o.result.head ? ` · head ${o.result.head}` : ""} · opened in a new tab`, "ok"));
          rec.forked = name;
          return rec;
        }
        case "merge": {
          const ws = a.filter((x) => x !== "+");
          if (ws.length !== 4 || ws[2] !== "as") { rec.lines.push(L("usage: merge <a> <b> as <c>", "err")); return rec; }
          const [left, right, , name] = ws;
          const o = await this.call(rec, "branch.merge", { branch: left, with: right, name });
          if (!o.ok) {
            rec.lines.push(refusal(o));
            if (o.code !== "Conflict") return rec;
            const r = o.refusal;
            rec.lines.push(L(`  ${left}@${r.sources[0].node} + ${right}@${r.sources[1].node} · merge base ${r.mergeBase}`, "dim"));
            for (const c of r.conflicts) {
              rec.lines.push(...conflictLines([c]));
              for (const h of c.hunks || []) {
                for (const t of h.ours) rec.lines.push(L(`      ${left.padEnd(10)} ${t.trim()}`, "del"));
                for (const t of h.theirs) rec.lines.push(L(`      ${right.padEnd(10)} ${t.trim()}`, "add"));
              }
            }
            rec.lines.push(L(`  make these files agree on ${left} or ${right}, then merge again`, "dim"));
            return rec;
          }
          const r = o.result;
          if (r.fastForward) rec.lines.push(L(`✓ Merged ${name} = ${left}@${r.sources[0].node} + ${right}@${r.sources[1].node} · ${r.mergeBase} is already in ${r.head}'s history, so ${name} points at ${r.head} (no new Commit) · opened in a new tab`, "ok"));
          else rec.lines.push(L(`✓ Merged ${name} = ${left}@${r.sources[0].node} + ${right}@${r.sources[1].node} · head ${r.head} · merge base ${r.mergeBase} · opened in a new tab`, "ok"));
          rec.lines.push(...lwwLines(r.lww));
          rec.forked = name;
          return rec;
        }
        case "publish": {
          if (!a[0]) { rec.lines.push(L("usage: publish <branch>", "err")); return rec; }
          const o = await this.call(rec, "branch.publish", { branch: a[0] });
          if (!o.ok) {
            rec.lines.push(refusal(o));
            return rec;
          }
          const r = o.result;
          rec.lines.push(r.kind === "Added" ? L(`✓ Added ${r.publishedLayer.id} from ${r.source.commit} · main is now ${r.main.headLayer}`, "ok")
            : r.kind === "UpToDate" ? L(`= UpToDate · already published as ${r.layer}`, "dim") : L("= NoChanges · Branch head equals main", "dim"));
          if (r.overwrote) rec.lines.push(L(`! main had moved to ${r.overwrote} since ${a[0]} was based on ${r.basedOn}: main now has ${a[0]}'s files; ${r.overwrote} stays in main's history`, "warn"));
          return rec;
        }
        case "diff": {
          if (a.length < 2) { rec.lines.push(L("usage: diff <a> <b>   (two Branches/main, or two Commits)", "err")); return rec; }
          const isC = (x) => /^C\d+$/.test(x);
          let o;
          if (isC(a[0]) && isC(a[1])) o = await this.call(rec, "branch.diff_commits", { from: a[0], to: a[1] });
          else if (!isC(a[0]) && !isC(a[1])) o = await this.call(rec, "branch.diff_branches", { from: a[0], to: a[1] });
          else { rec.lines.push(L("diff takes two Branches/main, or two Commits", "err")); return rec; }
          if (!o.ok) { rec.lines.push(refusal(o)); return rec; }
          rec.lines.push(L(`${a[0]} (${o.result.from.root}) → ${a[1]} (${o.result.to.root})`, "dim"));
          rec.lines.push(...diffLines(o.result.items));
          rec.diff = { from: a[0], to: a[1] };
          return rec;
        }
        default:
          rec.lines.push(L(`unknown history command: ${cmd} · type help`, "err"));
          return rec;
      }
    }
  }

  // ---------------------------------------------------------------- live commands
  // A real command: a trailing & runs it in the background. A server started
  // in the foreground would never return, so it is refused as in the simulator.
  function liveCommand(command) {
    const toks = tokenize(command);
    const background = toks.length > 0 && toks[toks.length - 1].op === "&";
    if (!background) {
      let last = [];
      for (const t of toks) { if (t.op === "&&" || t.op === "|") last = []; else if (t.t !== undefined) last.push(t.t); }
      if (isServer(last)) { const sub = last[1] === "run" ? last[2] : last[1]; return { refuse: true, out: [L(`npm run ${sub} runs until stopped · use: npm run ${sub} &`, "err")] }; }
    }
    return { command: background ? command.replace(/&\s*$/, "").trim() : command, background };
  }
  // stdout, then stderr (in red), as the command printed them.
  function execLines(result) {
    const lines = [];
    const add = (text, c) => { if (text) for (const t of text.replace(/\n$/, "").split("\n")) lines.push(L(t, c)); };
    add(result.stdout, ""); add(result.stderr, "err");
    if (result.truncated) lines.push(L("… output truncated at 1 MiB per stream", "dim"));
    return lines;
  }

  // ---------------------------------------------------------------- simulated shell
  // Computes the effect of one exec command on a working copy of the Workspace
  // tree. Returns writes for sandbox.exec, the output, and the exit code.
  function simulateShell(command, ws, sb) {
    const toks = tokenize(command);
    let background = false;
    if (toks.length && toks[toks.length - 1].op === "&") { background = true; toks.pop(); }
    if (toks.some((t) => t.op === "&")) return { refuse: true, out: [L("only a trailing & is simulated", "err")] };
    // split into && segments, each a pipeline of commands with optional redirect
    const segments = [[[]]];
    for (const t of toks) {
      if (t.op === "&&") segments.push([[]]);
      else if (t.op === "|") segments[segments.length - 1].push([]);
      else { const seg = segments[segments.length - 1]; seg[seg.length - 1].push(t); }
    }
    let n = 0;
    const fakeInode = () => "v" + ++n;
    let tree = ws.live;
    const writes = [], out = [];
    let code = 0;
    const procs = Object.values(sb.processes).filter((p) => p.path === ws.path && p.status === "running");
    // localhost is the Sandbox's: curl reaches a server from any of its Workspaces
    const sbProcs = Object.values(sb.processes).filter((p) => p.status === "running");
    for (const pipeline of segments) {
      let input = null, last = null;
      for (const [k, cmdToks] of pipeline.entries()) {
        const r = runOne(cmdToks, tree, input, { ws, procs, sbProcs, background: background && segments.indexOf(pipeline) === segments.length - 1 && k === pipeline.length - 1 });
        if (r.refuse) return { refuse: true, out: r.out };
        if (r.writes && r.writes.length) {
          try { tree = M.applyChanges(tree, r.writes, fakeInode); writes.push(...r.writes); }
          catch (e) { r.out = [L(`sh: ${e.message}`, "err")]; r.code = 1; }
        }
        if (r.background) background = true;
        input = r.out;
        last = r;
        if (r.code) break;
      }
      out.push(...(last.out || []));
      code = last.code || 0;
      if (code) break;
    }
    return { writes, out, code, background: background && !code && segmentsServer(segments) };
  }
  function segmentsServer(segments) {
    const lastSeg = segments[segments.length - 1];
    const w = words(lastSeg[lastSeg.length - 1]);
    return isServer(w);
  }
  const isServer = (w) => (w[0] === "npm" && ((w[1] === "run" && (w[2] === "start" || w[2] === "dev")) || w[1] === "start"));

  function runOne(toks, tree, input, ctx) {
    // pull a trailing redirect: cmd args > file   or   >> file
    let redirect = null;
    const ri = toks.findIndex((t) => t.op === ">" || t.op === ">>");
    if (ri >= 0) { redirect = { append: toks[ri].op === ">>", path: toks[ri + 1] && toks[ri + 1].t }; toks = toks.slice(0, ri); }
    const w = words(toks);
    if (!w.length) return { out: [], code: 0 };
    const [cmd, ...a] = w;
    const flags = a.filter((x) => /^-\w+$/.test(x)).join("");
    const args = a.filter((x) => !/^-\w+$/.test(x));
    const exists = (p) => !!tree[p];
    const isDir = (p) => p === "/" || (tree[p] && tree[p].type === "dir");
    const err = (msg, code = 1) => ({ out: [L(msg, "err")], code });
    const text = (lines) => ({ out: lines.map((x) => L(x)), code: 0 });
    let res;
    switch (cmd) {
      case "pwd": res = text([ctx.ws.path]); break;
      case "ls": {
        const p = abs(args[0]);
        if (!isDir(p)) { res = exists(p) ? text([rel(p)]) : err(`ls: ${args[0]}: No such file or directory`); break; }
        const names = M.childrenOf(tree, p).map((q) => M.baseName(q) + (tree[q].type === "dir" ? "/" : "")).filter((n) => flags.includes("a") || !n.startsWith("."));
        res = text([names.join("  ")]);
        break;
      }
      case "cat": {
        const outL = [];
        for (const f of args) { const p = abs(f); if (!exists(p)) return err(`cat: ${f}: No such file or directory`); if (isDir(p)) return err(`cat: ${f}: Is a directory`); outL.push(...tree[p].content.split("\n")); }
        res = text(outL);
        break;
      }
      case "echo": res = text([args.join(" ")]); break;
      case "touch": {
        const writes = args.filter((f) => !exists(abs(f))).map((f) => ({ kind: "write", path: abs(f), content: "" }));
        res = { out: [], code: 0, writes };
        break;
      }
      case "mkdir": res = { out: [], code: 0, writes: args.map((f) => ({ kind: "mkdir", path: abs(f), recursive: flags.includes("p") || undefined })) }; break;
      case "rm": {
        const missing = args.find((f) => !exists(abs(f)));
        if (missing && !flags.includes("f")) { res = err(`rm: ${missing}: No such file or directory`); break; }
        res = { out: [], code: 0, writes: args.filter((f) => exists(abs(f))).map((f) => ({ kind: "remove", path: abs(f), recursive: flags.includes("r") || undefined })) };
        break;
      }
      case "cp": case "mv":
        if (args.length < 2) { res = err(`usage: ${cmd} <from> <to>`); break; }
        res = { out: [], code: 0, writes: [{ kind: cmd, from: abs(args[0]), to: abs(args[1]), recursive: cmd === "cp" && flags.includes("r") ? true : undefined }] };
        break;
      case "sed": {
        const expr = args[0], file = args[1];
        const m = expr && expr.match(/^s(.)(.*?)\1(.*?)\1(g?)$/);
        const del = expr && expr.match(/^\/(.*)\/d$/);
        if (!flags.includes("i") || !(m || del) || !file) { res = err("sed: only sed -i 's/old/new/[g]' or '/pattern/d' <file> is simulated"); break; }
        const p = abs(file);
        if (!exists(p)) { res = err(`sed: ${file}: No such file or directory`); break; }
        if (del) {
          // basic regular expression: \| alternates, other ERE operators are literal
          const re = new RegExp(del[1].split("\\|").map((x) => x.replace(/[+?(){}|]/g, "\\$&")).join("|"));
          const content = tree[p].content.split("\n").filter((ln) => !re.test(ln)).join("\n");
          res = { out: [], code: 0, writes: content === tree[p].content ? [] : [{ kind: "write", path: p, content }] };
          break;
        }
        const [, , from, to, g] = m;
        const lit = from.replace(/\\(.)/g, "$1");
        const repl = (match) => to.replace(/\\&|&/g, (x) => (x === "&" ? match : "&")).replace(/\\(.)/g, "$1");
        const content = tree[p].content.split("\n").map((ln) => {
          if (g) return ln.split(lit).join(repl(lit));
          const i = ln.indexOf(lit);
          return i < 0 ? ln : ln.slice(0, i) + repl(lit) + ln.slice(i + lit.length);
        }).join("\n");
        res = { out: [], code: 0, writes: content === tree[p].content ? [] : [{ kind: "write", path: p, content }] };
        break;
      }
      case "grep": {
        const pat = args[0];
        if (!pat) { res = err("usage: grep <text> [file]"); break; }
        let src;
        if (input) src = input.map((x) => x.t);
        else { const p = abs(args[1]); if (!exists(p) || isDir(p)) { res = err(`grep: ${args[1] || ""}: No such file`, 2); break; } src = tree[p].content.split("\n"); }
        const hits = src.filter((x) => x.includes(pat));
        res = hits.length ? text(hits) : { out: [], code: 1 };
        break;
      }
      case "head": {
        const nArg = a.indexOf("-n") >= 0 ? +a[a.indexOf("-n") + 1] : 10;
        res = text((input || []).slice(0, nArg).map((x) => x.t));
        break;
      }
      case "npm": res = npm(args, flags, tree, ctx); break;
      case "node": res = text(["v22.11.0"]); if (args[0] !== "-v" && args[0] !== "--version") res = err("sh: node scripts are not simulated in this preview", 127); break;
      case "curl": {
        const url = args.find((x) => x.startsWith("http"));
        if (!url) { res = err("curl: no URL"); break; }
        const route = url.replace(/^https?:\/\/[^/]+/, "") || "/";
        const server = (ctx.sbProcs || ctx.procs).find((p) => /npm (run )?(start|dev)/.test(p.command));
        if (!server) { res = err("curl: (7) Failed to connect to localhost port 3000: Connection refused", 7); break; }
        const dev = /dev/.test(server.command);
        const name = route === "/" ? "index" : route.replace(/^\//, "");
        if (dev) {
          const page = `/app${route === "/" ? "" : route}/page.tsx`.replace("//", "/");
          if (!exists(page)) { res = text(["<h1>404: This page could not be found.</h1>"]); break; }
          const h = tree[page].content.match(/<h1>(.*?)<\/h1>/);
          res = text([`<h1>${h ? h[1] : ""}</h1>`]);
        } else {
          const built = `/.next/server/app/${name}.html`;
          res = exists(built) ? text([tree[built].content]) : text(["<h1>404: This page could not be found.</h1>"]);
        }
        break;
      }
      case "git": res = err("sh: git is not simulated in this preview", 127); break;
      default: res = err(`sh: ${cmd}: not simulated in this preview`, 127);
    }
    if (redirect && !res.code) {
      if (!redirect.path) return err("sh: syntax error near unexpected token `newline'", 2);
      const p = abs(redirect.path);
      const body = res.out.map((x) => x.t).join("\n");
      const content = redirect.append && exists(p) ? tree[p].content + (tree[p].content ? "\n" : "") + body : body;
      res = { out: [], code: 0, writes: [...(res.writes || []), { kind: "write", path: p, content }] };
    }
    for (const wr of res.writes || []) for (const k of Object.keys(wr)) if (wr[k] === undefined) delete wr[k];
    return res;
  }

  function npm(args, flags, tree, ctx) {
    const err = (msg, code = 1) => ({ out: msg.split("\n").map((x) => L(x, "err")), code });
    const ok = (lines, writes = [], extra = {}) => ({ out: lines.map((x) => L(x, "dim")), code: 0, writes, ...extra });
    if (!tree["/package.json"]) return err("npm error enoent Could not read package.json");
    const sub = args[0] === "run" ? args[1] : args[0];
    const hasDeps = !!tree["/node_modules/next/package.json"];
    if (sub === "ci" || sub === "install" || sub === "i")
      return ok(["added 1 package, and audited 2 packages in 2s", "found 0 vulnerabilities"], [
        { kind: "mkdir", path: "/node_modules/next", recursive: true },
        { kind: "write", path: "/node_modules/next/package.json", content: '{ "name": "next", "version": "15.0.3" }' },
        { kind: "write", path: "/package-lock.json", content: '{ "lockfileVersion": 3 }' },
      ]);
    if (!hasDeps && ["build", "start", "dev", "test"].includes(sub)) return err(`> website@ ${sub}\nsh: next: command not found`, 127);
    if (sub === "build") {
      const pages = Object.keys(tree).filter((p) => /^\/app(\/.*)?\/page\.tsx$/.test(p)).sort();
      for (const p of pages) {
        const lines = tree[p].content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(/>([^<>{}]*'[^<>{}]*)</);
          if (m) return err(`Failed to compile.\n\n.${p}\n${i + 1}:${lines[i].indexOf(m[1]) + 1}  Error: \`'\` can be escaped with \`&apos;\`.  react/no-unescaped-entities`);
        }
      }
      const writes = [{ kind: "mkdir", path: "/.next/server/app", recursive: true }, { kind: "write", path: "/.next/BUILD_ID", content: "b" + pages.length + Object.keys(tree).length + "-" + ctx.ws.sandbox.slice(3) + ctx.ws.path.split("/").pop() }];
      for (const p of pages) {
        const h = tree[p].content.match(/<h1>(.*?)<\/h1>/);
        const name = p === "/app/page.tsx" ? "index" : p.slice(5, -9);
        writes.push({ kind: "write", path: `/.next/server/app/${name}.html`, content: `<h1>${h ? h[1] : ""}</h1>` });
      }
      return ok(["▲ Next.js 15.0.3", "✓ Compiled successfully", `✓ Generating static pages (${pages.length}/${pages.length})`], writes);
    }
    if (sub === "start" || sub === "dev") {
      if (!ctx.background) return { refuse: true, out: [L(`npm run ${sub} runs until stopped · use: npm run ${sub} &`, "err")] };
      if (sub === "start" && !tree["/.next/BUILD_ID"]) return err("Error: Could not find a production build in the '.next' directory. Try building your app with 'next build'.");
      const writes = sub === "dev" ? [{ kind: "mkdir", path: "/.next/cache", recursive: true }, { kind: "write", path: "/.next/cache/dev.json", content: "{}" }] : [];
      return ok([`▲ Next.js 15.0.3${sub === "dev" ? " (dev)" : ""}`, "- Local: http://localhost:3000", "✓ Ready"], writes);
    }
    if (sub === "test") {
      // every "@/x" import must resolve to /x.ts or /x.tsx
      for (const p of Object.keys(tree).sort()) {
        if (tree[p].type !== "file" || !/\.tsx?$/.test(p) || p.startsWith("/node_modules")) continue;
        for (const m of tree[p].content.matchAll(/from "@\/([^"]+)"/g))
          if (!tree[`/${m[1]}.ts`] && !tree[`/${m[1]}.tsx`]) return err(`FAIL  .${p}\n  Cannot find module '@/${m[1]}'\nTests: 1 failed`);
      }
      return ok(["PASS  app/page.test.tsx", "Tests: 1 passed"]);
    }
    return err(`npm error Missing script: "${sub}"`);
  }

  const api = { Engine, tokenize, simulateShell, liveCommand, execLines };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.LayerTerm = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
