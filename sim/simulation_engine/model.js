// LayerFS SDK simulator: an in-memory model of the *proposed* agent-facing SDK
// (sdk_js.md, issue #322). It reproduces the decision rules only; it is not the
// product. Proposals simulated here: Commit kinds normal/overwrite with
// three-way merge of a stale Workspace, Branch merge, .lww rules and
// overwrite-only publish to main.
(function (global) {
  "use strict";

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const J = (v) => JSON.stringify(v);

  class Refusal extends Error {
    constructor(code, message, detail) {
      super(message);
      this.code = code;
      this.detail = detail || {};
    }
  }
  const refuse = (code, message, detail) => {
    throw new Refusal(code, message, detail);
  };

  // ---------------------------------------------------------------- file trees
  // A tree is { "/path": { type: "file"|"dir", inode, content? } }; "/" is implicit.
  const parentOf = (p) => (p.lastIndexOf("/") <= 0 ? "/" : p.slice(0, p.lastIndexOf("/")));
  const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);
  const isUnder = (p, dir) => p === dir || p.startsWith(dir === "/" ? "/" : dir + "/");
  const childrenOf = (tree, dir) =>
    Object.keys(tree)
      .filter((p) => p !== dir && parentOf(p) === dir)
      .sort();

  function treeKey(tree) {
    return Object.keys(tree)
      .sort()
      .map((p) => {
        const e = tree[p];
        return `${p}\u0000${e.type}\u0000${e.inode}\u0000${e.content ?? ""}`;
      })
      .join("\u0001");
  }

  function countOccurrences(text, needle) {
    if (!needle) return 0;
    let n = 0,
      i = 0;
    while ((i = text.indexOf(needle, i)) !== -1) {
      n++;
      i += needle.length;
    }
    return n;
  }

  // Applies one ordered change list to a copy of `tree`. Throws a Refusal on the
  // first invalid change, so callers never observe a partially changed tree.
  function applyChanges(tree, changes, newInode) {
    const t = clone(tree);
    const need = (p) => {
      if (!t[p]) refuse("NoSuchPath", `${p} does not exist`, { path: p });
      return t[p];
    };
    const needParent = (p) => {
      const d = parentOf(p);
      if (d !== "/" && (!t[d] || t[d].type !== "dir")) refuse("NoSuchPath", `parent ${d} does not exist`, { path: d });
    };
    for (const c of changes) {
      switch (c.kind) {
        case "write": {
          needParent(c.path);
          const e = t[c.path];
          if (e && e.type === "dir") refuse("IsDirectory", `${c.path} is a directory`, { path: c.path });
          t[c.path] = { type: "file", inode: e ? e.inode : newInode(), content: c.content };
          break;
        }
        case "edit": {
          const e = need(c.path);
          if (e.type !== "file") refuse("IsDirectory", `${c.path} is a directory`, { path: c.path });
          const n = countOccurrences(e.content, c.oldText);
          if (n === 0) refuse("NoMatch", `oldText not found in ${c.path}`, { path: c.path });
          if (n > 1 && !c.all)
            refuse("AmbiguousMatch", `oldText matches ${n} times in ${c.path}`, { path: c.path, matches: n });
          e.content = c.all ? e.content.split(c.oldText).join(c.newText) : e.content.replace(c.oldText, c.newText);
          break;
        }
        case "mkdir": {
          if (t[c.path]) {
            if (c.recursive && t[c.path].type === "dir") break;
            refuse("Exists", `${c.path} exists`, { path: c.path });
          }
          if (c.recursive) {
            const parts = c.path.split("/").filter(Boolean);
            let p = "";
            for (const part of parts) {
              p += "/" + part;
              if (!t[p]) t[p] = { type: "dir", inode: newInode() };
              else if (t[p].type !== "dir") refuse("NotDirectory", `${p} is a file`, { path: p });
            }
          } else {
            needParent(c.path);
            t[c.path] = { type: "dir", inode: newInode() };
          }
          break;
        }
        case "remove": {
          const e = need(c.path);
          if (e.type === "dir" && childrenOf(t, c.path).length && !c.recursive)
            refuse("NotEmpty", `${c.path} is not empty`, { path: c.path });
          for (const p of Object.keys(t)) if (isUnder(p, c.path)) delete t[p];
          break;
        }
        case "cp": {
          const e = need(c.from);
          if (t[c.to]) refuse("Exists", `${c.to} exists`, { path: c.to });
          needParent(c.to);
          if (e.type === "dir" && !c.recursive)
            refuse("IsDirectory", `${c.from} needs recursive: true`, { path: c.from });
          for (const p of Object.keys(t)
            .filter((q) => isUnder(q, c.from))
            .sort()) {
            const src = t[p];
            t[c.to + p.slice(c.from.length)] = { ...clone(src), inode: newInode() };
          }
          break;
        }
        case "mv": {
          need(c.from);
          if (t[c.to]) refuse("Exists", `${c.to} exists`, { path: c.to });
          needParent(c.to);
          if (isUnder(c.to, c.from)) refuse("InvalidMove", `cannot move ${c.from} into itself`, { path: c.to });
          for (const p of Object.keys(t)
            .filter((q) => isUnder(q, c.from))
            .sort()) {
            t[c.to + p.slice(c.from.length)] = t[p];
            delete t[p];
          }
          break;
        }
        default:
          refuse("InvalidInput", `unknown change kind ${c.kind}`);
      }
    }
    return t;
  }

  // ---------------------------------------------------------------- diffs
  function lineDiff(a, b) {
    const x = (a ?? "").split("\n"),
      y = (b ?? "").split("\n");
    const m = x.length,
      n = y.length;
    const L = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--)
        L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    let i = 0,
      j = 0;
    while (i < m && j < n) {
      if (x[i] === y[j]) {
        out.push({ op: " ", text: x[i] });
        i++;
        j++;
      } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "-", text: x[i++] });
      else out.push({ op: "+", text: y[j++] });
    }
    while (i < m) out.push({ op: "-", text: x[i++] });
    while (j < n) out.push({ op: "+", text: y[j++] });
    return out;
  }

  // Filesystem comparison from `a` to `b`: Added means present only in b.
  function diffTrees(a, b) {
    const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    const entries = [];
    for (const p of paths) {
      const l = a[p],
        r = b[p];
      if (!l) entries.push({ path: p, kind: "Added", type: r.type, after: r });
      else if (!r) entries.push({ path: p, kind: "Removed", type: l.type, before: l });
      else {
        const content = (l.content ?? null) !== (r.content ?? null);
        const identity = l.inode !== r.inode;
        const type = l.type !== r.type;
        if (content || identity || type)
          entries.push({
            path: p,
            kind: "Modified",
            type: r.type,
            before: l,
            after: r,
            content,
            identity,
            hunks: content && l.type === "file" && r.type === "file" ? lineDiff(l.content, r.content) : null,
          });
      }
    }
    return entries;
  }

  // ---------------------------------------------------------------- merge
  // Proposal only: three-way merge with conflict markers and .lww rules.
  const MARKERS = /^<<<<<<< .*$[\s\S]*?^=======$[\s\S]*?^>>>>>>> .*$/m;
  const hasMarkers = (text) => typeof text === "string" && MARKERS.test(text);
  const sameEntry = (x, y) =>
    (!x && !y) || (!!x && !!y && x.type === y.type && (x.content ?? null) === (y.content ?? null));

  // For each line of `a`, the index of the matching line of `b` (or -1).
  function matchLines(a, b) {
    const m = new Array(a.length).fill(-1);
    let i = 0,
      j = 0;
    for (const op of lineDiff(a.join("\n"), b.join("\n"))) {
      if (op.op === " ") {
        m[i] = j;
        i++;
        j++;
      } else if (op.op === "-") i++;
      else j++;
    }
    return m;
  }

  // Line merge: chunks between lines unchanged on both sides take the side
  // that changed; both changing them differently is a conflict block.
  function merge3Lines(base, ours, theirs, labels) {
    const b = (base ?? "").split("\n"),
      o = ours.split("\n"),
      t = theirs.split("\n");
    const mo = matchLines(b, o),
      mt = matchLines(b, t);
    const out = [];
    const hunks = [];
    let bi = 0,
      oi = 0,
      ti = 0;
    const eq = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);
    const chunk = (be, oe, te) => {
      const cb = b.slice(bi, be),
        co = o.slice(oi, oe),
        ct = t.slice(ti, te);
      if (eq(co, cb)) out.push(...ct);
      else if (eq(ct, cb) || eq(co, ct)) out.push(...co);
      else {
        hunks.push({ line: out.length + 1, ours: co, theirs: ct });
        out.push(`<<<<<<< ${labels[0]}`, ...co, "=======", ...ct, `>>>>>>> ${labels[1]}`);
      }
    };
    for (let k = 0; k < b.length; k++) {
      if (mo[k] < 0 || mt[k] < 0 || mo[k] < oi || mt[k] < ti) continue;
      chunk(k, mo[k], mt[k]);
      out.push(b[k]);
      bi = k + 1;
      oi = mo[k] + 1;
      ti = mt[k] + 1;
    }
    chunk(b.length, o.length, t.length);
    return { text: out.join("\n"), conflicts: hunks.length, hunks };
  }

  // gitignore-style rules from /.lww; "%include <file>" reads another file
  // of the same tree (for example .gitignore). Last matching rule wins.
  function lwwRules(tree, file = "/.lww", seen = new Set()) {
    const e = tree[file];
    if (!e || e.type !== "file" || seen.has(file)) return [];
    seen.add(file);
    const rules = [];
    for (let line of e.content.split("\n")) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      const inc = line.match(/^%include\s+(\S+)$/);
      if (inc) {
        rules.push(...lwwRules(tree, "/" + inc[1].replace(/^\/+/, ""), seen));
        continue;
      }
      const neg = line.startsWith("!");
      let pat = (neg ? line.slice(1) : line).replace(/\/$/, "");
      const anchored = pat.includes("/");
      pat = pat.replace(/^\//, "");
      const rx = pat
        .split("**")
        .map((s) =>
          s
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, "[^/]"),
        )
        .join(".*");
      rules.push({ pattern: line, neg, re: new RegExp((anchored ? "^" : "(^|/)") + rx + "($|/)") });
    }
    return rules;
  }
  const lwwMatch = (rules, path) => {
    let hit = null;
    for (const r of rules) if (r.re.test(path.replace(/^\//, ""))) hit = r.neg ? null : r;
    return hit;
  };

  // Three-way tree merge. opts: { labels: [ours, theirs], rules, timeOurs(p),
  // timeTheirs(p) }. Returns { tree, conflicts, lww, clean }.
  function merge3Trees(base, ours, theirs, opts, newInode) {
    const tree = {},
      conflicts = [],
      lww = [];
    const [lo, lt] = opts.labels;
    for (const p of [...new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])].sort()) {
      const b = base[p],
        o = ours[p],
        t = theirs[p];
      let r;
      if (sameEntry(o, t)) r = o;
      else if (sameEntry(b, o)) r = t;
      else if (sameEntry(b, t)) r = o;
      else {
        const rule = lwwMatch(opts.rules || [], p);
        if (rule) {
          const to = opts.timeOurs(p),
            tt = opts.timeTheirs(p),
            keepOurs = to >= tt;
          r = keepOurs ? o : t;
          lww.push({ path: p, kept: keepOurs ? lo : lt, deleted: !r, rule: rule.pattern });
        } else if (o && t && o.type === "file" && t.type === "file") {
          const m = merge3Lines(b && b.type === "file" ? b.content : "", o.content, t.content, opts.labels);
          r = { ...o, content: m.text };
          if (m.conflicts)
            conflicts.push({ path: p, kind: b ? "content" : "add/add", blocks: m.conflicts, hunks: m.hunks });
        } else if ((o && o.type === "file") || (t && t.type === "file")) {
          const kept = o || t;
          r = {
            ...kept,
            content: o
              ? `<<<<<<< ${lo}\n${o.content}\n=======\n>>>>>>> ${lt} (deleted)`
              : `<<<<<<< ${lo} (deleted)\n=======\n${t.content}\n>>>>>>> ${lt}`,
          };
          conflicts.push({ path: p, kind: o ? "modify/delete" : "delete/modify", blocks: 1 });
        } else {
          r = o || t;
          conflicts.push({ path: p, kind: "type", blocks: 0 });
        }
      }
      if (r) tree[p] = clone(r);
    }
    for (const p of Object.keys(tree)) // a kept path needs its folders
      for (let d = parentOf(p); d !== "/" && !tree[d]; d = parentOf(d))
        tree[d] = clone(
          ours[d] && ours[d].type === "dir"
            ? ours[d]
            : theirs[d] && theirs[d].type === "dir"
              ? theirs[d]
              : { type: "dir", inode: newInode() },
        );
    return { tree, conflicts, lww, clean: conflicts.length === 0 };
  }

  // ---------------------------------------------------------------- the model
  class Sim {
    constructor() {
      this.s = {
        project: null,
        main: null,
        roots: {},
        rootKeys: {},
        commits: {},
        layers: {},
        branches: {},
        branchOrder: [],
        sandboxes: {},
        sandboxOrder: [],
        seq: { root: 0, commit: 0, layer: 0, inode: 0, sandbox: 0, proc: 0, slot: 0, clock: 0 },
      };
    }

    snapshot() {
      return clone(this.s);
    }

    // -- identities
    newInode() {
      return "i" + ++this.s.seq.inode;
    }
    slot() {
      return this.s.seq.slot++;
    }
    tick() {
      return ++this.s.seq.clock;
    }
    intern(tree) {
      const key = treeKey(tree);
      if (this.s.rootKeys[key]) return this.s.rootKeys[key];
      const id = "R" + this.s.seq.root++;
      this.s.rootKeys[key] = id;
      this.s.roots[id] = clone(tree);
      return id;
    }

    // -- lookups
    branch(name) {
      const b = this.s.branches[name];
      if (!b) refuse("NoSuchBranch", `no Branch named ${name}`, { branch: name });
      return b;
    }
    branchRoot(b) {
      return b.head ? this.s.commits[b.head].root : this.s.layers[b.base].root;
    }
    sandbox(id) {
      const sb = this.s.sandboxes[id];
      if (!sb) refuse("NoSuchSandbox", `no Sandbox ${id} owned by this controller`, { sandbox: id });
      if (sb.closed) refuse("SandboxClosed", `${id} is closed`, { sandbox: id });
      return sb;
    }
    workspace(sbId, path) {
      const sb = this.sandbox(sbId);
      const ws = sb.workspaces[path];
      if (!ws || !ws.mounted) refuse("NotMounted", `${sbId}:${path} is not mounted`, { workspace: `${sbId}:${path}` });
      return ws;
    }
    liveMountsOf(branchName) {
      const out = [];
      for (const id of this.s.sandboxOrder) {
        const sb = this.s.sandboxes[id];
        if (sb.closed) continue;
        for (const p of sb.wsOrder)
          if (sb.workspaces[p].mounted && sb.workspaces[p].branch === branchName) out.push(`${id}:${p}`);
      }
      return out;
    }

    // Resolves any readable selector to { label, kind, tree }.
    // "main", a Branch name, "C3", "L1", or a live view "sb_01:/workspaces/1".
    resolve(ref) {
      const s = this.s;
      if (ref === "main") {
        if (!s.main) refuse("NoProject", "project not initialized");
        const l = s.layers[s.main.head];
        return { label: `main @ ${l.id}`, kind: "main", root: l.root, tree: s.roots[l.root], layer: l.id };
      }
      if (/^C\d+$/.test(ref)) {
        const c = s.commits[ref];
        if (!c) refuse("NoSuchCommit", `no Commit ${ref}`);
        return { label: ref, kind: "commit", root: c.root, tree: s.roots[c.root], commit: ref };
      }
      if (/^L\d+$/.test(ref)) {
        const l = s.layers[ref];
        if (!l) refuse("NoSuchLayer", `no Layer ${ref}`);
        return { label: ref, kind: "layer", root: l.root, tree: s.roots[l.root], layer: ref };
      }
      if (ref.includes(":/")) {
        const [sb, path] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
        const w = s.sandboxes[sb] && s.sandboxes[sb].workspaces[path];
        if (!w) refuse("NotMounted", `${ref} does not exist`);
        return { label: `${ref} (live)`, kind: "live", root: null, tree: w.live, workspace: ref };
      }
      const b = this.branch(ref);
      const root = this.branchRoot(b);
      return { label: `${b.name} @ ${b.head || b.base}`, kind: "branch", root, tree: s.roots[root], head: b.head };
    }

    // -- operation entry point: one attempt, typed result or typed refusal
    run(call, args = {}) {
      const fn = OPS[call];
      if (!fn)
        return { ok: false, code: "Unsupported", refusal: { code: "Unsupported", message: `unknown call ${call}` } };
      try {
        const result = fn.call(this, args);
        const code = result && result.kind ? result.kind : "ok";
        return { ok: true, code, result };
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        return { ok: false, code: e.code, refusal: { code: e.code, message: e.message, ...e.detail } };
      }
    }

    // -- fs mutation shared by write/edit/mkdir/remove/cp/mv/apply. Allowed
    // while mounted: it advances the head, so live mounts become stale.
    mutate(branchName, changes, via, message) {
      const b = this.branch(branchName);
      const capturedHead = b.head;
      const currentRoot = this.branchRoot(b);
      const tree = applyChanges(this.s.roots[currentRoot], changes, () => this.newInode());
      const root = this.intern(tree);
      if (root === currentRoot)
        return { kind: "UpToDate", branch: b.name, head: b.head, root, capturedHead, displacedHead: null };
      const id = "C" + ++this.s.seq.commit;
      this.s.commits[id] = {
        id,
        parent: capturedHead,
        root,
        base: b.base,
        branch: b.name,
        slot: this.slot(),
        by: "fs",
        via,
        time: this.tick(),
        ...(message ? { message } : {}),
      };
      b.head = id;
      return { kind: "Committed", branch: b.name, head: id, root, capturedHead, displacedHead: null };
    }

    // -- history graph: nodes are Commits ("C#") and Layers ("L#")
    node(id) {
      return this.s.commits[id] || this.s.layers[id];
    }
    nodeTree(id) {
      return this.s.roots[this.node(id).root];
    }
    firstParent(id) {
      const c = this.s.commits[id];
      return c ? c.parent || c.base : this.s.layers[id].parent;
    }
    // The node a merge source names: main's head, or a Branch head (its fork point before any Commit).
    sourceNode(ref) {
      if (ref === "main") return this.s.main.head;
      if (/^[CL]\d+$/.test(ref)) {
        if (!this.node(ref)) refuse("NoSuchCommit", `no Commit or Layer ${ref}`);
        return ref;
      }
      const b = this.branch(ref);
      return b.head || b.from;
    }
    // Every node reachable through parents, merge sources and published sources.
    ancestors(id) {
      const out = new Set(),
        todo = [id];
      while (todo.length) {
        const n = todo.pop();
        if (!n || out.has(n)) continue;
        out.add(n);
        const c = this.s.commits[n];
        if (c) todo.push(c.parent || c.base, c.mergedFrom);
        else todo.push(this.s.layers[n].parent, this.s.layers[n].sourceCommit);
      }
      return out;
    }
    // Latest common ancestor of two nodes.
    mergeBase(a, b) {
      const A = this.ancestors(a);
      let best = null;
      for (const n of this.ancestors(b)) if (A.has(n) && (!best || this.node(n).time > this.node(best).time)) best = n;
      return best;
    }
    // Time of the newest first-parent node after `stop` that changed `path`.
    changeTime(id, path, stop) {
      for (let n = id; n && n !== stop; n = this.firstParent(n)) {
        const prev = this.firstParent(n);
        if (!sameEntry(this.nodeTree(n)[path], prev ? this.nodeTree(prev)[path] : undefined)) return this.node(n).time;
      }
      return 0;
    }
    merge(base, ours, theirs, opts) {
      return merge3Trees(base, ours, theirs, opts, () => this.newInode());
    }
    // Changed files of a Workspace that still hold a conflict block.
    markersIn(ws) {
      return diffTrees(this.s.roots[ws.baseRoot], ws.live)
        .filter((d) => d.kind !== "Removed" && d.type === "file" && hasMarkers(ws.live[d.path].content))
        .map((d) => d.path);
    }
  }

  const OPS = {
    // ---------------------------------------------------------- project
    "project.init"(a) {
      if (this.s.project) refuse("Exists", "project already initialized");
      const tree = {};
      for (const [p, v] of Object.entries(a.files)) {
        // create parent directories implicitly for the imported source tree
        let d = parentOf(p);
        const dirs = [];
        while (d !== "/" && !tree[d]) {
          dirs.unshift(d);
          d = parentOf(d);
        }
        for (const dir of dirs) tree[dir] = { type: "dir", inode: this.newInode() };
        tree[p] =
          v === null ? { type: "dir", inode: this.newInode() } : { type: "file", inode: this.newInode(), content: v };
      }
      const root = this.intern(tree);
      const id = "L" + this.s.seq.layer++;
      this.s.layers[id] = {
        id,
        parent: null,
        root,
        sourceBranch: null,
        sourceCommit: null,
        slot: this.slot(),
        time: this.tick(),
      };
      this.s.project = { name: a.name };
      this.s.main = { head: id };
      return { kind: "Initialized", project: a.name, main: { headLayer: id, root } };
    },
    "project.list_branches"() {
      return {
        kind: "ok",
        items: this.s.branchOrder.map((n) => {
          const b = this.s.branches[n];
          return { name: n, base: b.base, head: b.head, root: this.branchRoot(b), mountedBy: this.liveMountsOf(n) };
        }),
        nextCursor: null,
      };
    },
    "main.fork"(a) {
      return forkFrom.call(this, a.name, this.s.main.head, null);
    },
    "main.list_layers"() {
      const out = [];
      for (let id = this.s.main.head; id; id = this.s.layers[id].parent) out.push(clone(this.s.layers[id]));
      return { kind: "ok", items: out, nextCursor: null };
    },

    // ---------------------------------------------------------- branch
    "branch.fork"(a) {
      const b = this.branch(a.branch);
      return forkFrom.call(this, a.name, b.base, a.fromCommit || b.head);
    },
    "branch.list_commits"(a) {
      const b = this.branch(a.branch);
      const out = [];
      for (let id = b.head; id; id = this.s.commits[id].parent) out.push(clone(this.s.commits[id]));
      return { kind: "ok", items: out, nextCursor: null };
    },
    "branch.diff_commits"(a) {
      const l = this.resolve(a.from),
        r = this.resolve(a.to);
      if (l.kind !== "commit" || r.kind !== "commit") refuse("InvalidInput", "diff_commits takes two saved Commits");
      return {
        kind: "ok",
        from: { commit: a.from, root: l.root },
        to: { commit: a.to, root: r.root },
        items: diffTrees(l.tree, r.tree),
      };
    },
    "branch.diff_branches"(a) {
      const l = this.resolve(a.from),
        r = this.resolve(a.to);
      if (!["branch", "main"].includes(l.kind) || !["branch", "main"].includes(r.kind))
        refuse("InvalidInput", "diff_branches takes Branches or main");
      return {
        kind: "ok",
        from: { ref: a.from, label: l.label, root: l.root },
        to: { ref: a.to, label: r.label, root: r.root },
        items: diffTrees(l.tree, r.tree),
      };
    },
    // Proposal: publish is overwrite-only. The new Layer sits on main's current
    // head and holds exactly the Branch head's files, whatever main gained since
    // the Branch's base (reported as `overwrote`; those Layers stay in history).
    "branch.publish"(a) {
      const b = this.branch(a.branch);
      const cid = a.commit || b.head;
      if (!cid) refuse("NoCommit", `${b.name} has no saved Commit to publish`);
      const c = this.s.commits[cid];
      const already = Object.values(this.s.layers).find((l) => l.sourceBranch === b.name && l.sourceCommit === cid);
      if (already)
        return {
          kind: "UpToDate",
          layer: already.id,
          main: { headLayer: this.s.main.head, root: this.s.layers[this.s.main.head].root },
        };
      if (b.head !== cid) refuse("HeadMoved", `${b.name} head is ${b.head}, not ${cid}`);
      const parent = this.s.main.head;
      if (c.root === this.s.layers[parent].root) return { kind: "NoChanges", main: { headLayer: parent } };
      const id = "L" + this.s.seq.layer++;
      this.s.layers[id] = {
        id,
        parent,
        root: c.root,
        sourceBranch: b.name,
        sourceCommit: cid,
        slot: this.slot(),
        time: this.tick(),
      };
      this.s.main.head = id;
      // main's previous head is covered when it is in the Commit's history or was published from it.
      const anc = this.ancestors(cid),
        pl = this.s.layers[parent];
      const overwrote = anc.has(parent) || (pl.sourceCommit && anc.has(pl.sourceCommit)) ? null : parent;
      return {
        kind: "Added",
        source: { branch: b.name, commit: cid },
        publishedLayer: { id, parent, root: c.root },
        main: { headLayer: id, root: c.root },
        basedOn: b.base,
        overwrote,
      };
    },
    // Proposal: a + b = c. Merging never changes either input: it forks a new
    // Branch `name` from a's head whose first Commit is the three-way merge of
    // a and b (either may be main). A conflict rejects with the conflicting
    // files and both sides' lines; nothing is created.
    "branch.merge"(a) {
      const left = a.branch,
        right = a.with;
      if (left === right) refuse("InvalidInput", "merge takes two different sources");
      if (!a.name) refuse("InvalidInput", "merge needs a name for the new Branch");
      if (a.name === "main") refuse("ReservedName", `"main" names the project's main line`);
      if (this.s.branches[a.name]) refuse("NameTaken", `Branch ${a.name} already exists`);
      const ln = this.sourceNode(left),
        rn = this.sourceNode(right);
      // One side already contains the other: c just points at the newer node (metadata only).
      const newer = this.ancestors(ln).has(rn) ? ln : this.ancestors(rn).has(ln) ? rn : null;
      if (newer) {
        const c = this.s.commits[newer];
        const b = { name: a.name, base: c ? c.base : newer, head: c ? newer : null, from: newer, slot: this.slot() };
        this.s.branches[a.name] = b;
        this.s.branchOrder.push(a.name);
        return {
          kind: "Merged",
          fastForward: true,
          branch: a.name,
          head: newer,
          root: this.node(newer).root,
          sources: [
            { ref: left, node: ln },
            { ref: right, node: rn },
          ],
          mergeBase: newer === ln ? rn : ln,
          conflicts: [],
          lww: [],
        };
      }
      const mb = this.mergeBase(ln, rn);
      const ours = this.nodeTree(ln);
      const m = this.merge(this.nodeTree(mb), ours, this.nodeTree(rn), {
        labels: [`${left}@${ln}`, `${right}@${rn}`],
        rules: lwwRules(ours),
        timeOurs: (p) => this.changeTime(ln, p, mb),
        timeTheirs: (p) => this.changeTime(rn, p, mb),
      });
      const sources = [
        { ref: left, node: ln },
        { ref: right, node: rn },
      ];
      if (!m.clean)
        refuse(
          "Conflict",
          `${left} + ${right} conflict in ${m.conflicts.length} file${m.conflicts.length === 1 ? "" : "s"}; nothing was created`,
          { sources, mergeBase: mb, conflicts: m.conflicts, lww: m.lww },
        );
      // c's base Layer: main's head when main is one side, else a's base.
      const base = left === "main" ? ln : right === "main" ? rn : this.s.commits[ln] ? this.s.commits[ln].base : ln;
      const b = { name: a.name, base, head: null, from: ln, slot: this.slot() };
      this.s.branches[a.name] = b;
      this.s.branchOrder.push(a.name);
      const root = this.intern(m.tree);
      const id = "C" + ++this.s.seq.commit;
      this.s.commits[id] = {
        id,
        parent: this.s.commits[ln] ? ln : null,
        root,
        base,
        branch: a.name,
        slot: this.slot(),
        by: "merge",
        via: `merge ${left} + ${right}`,
        mergedFrom: rn,
        mergeBase: mb,
        lww: m.lww,
        time: this.tick(),
        ...(a.message ? { message: a.message } : {}),
      };
      b.head = id;
      return { kind: "Merged", branch: a.name, head: id, root, sources, mergeBase: mb, conflicts: [], lww: m.lww };
    },

    // ---------------------------------------------------------- fs reads
    "fs.read"(a) {
      const v = this.resolve(a.commit || a.ref);
      const e = v.tree[a.path];
      if (!e) refuse("NoSuchPath", `${a.path} does not exist at ${v.label}`, { path: a.path });
      if (e.type !== "file") refuse("IsDirectory", `${a.path} is a directory`, { path: a.path });
      return { kind: "ok", snapshot: v.label, root: v.root, path: a.path, inode: e.inode, text: e.content };
    },
    "fs.list"(a) {
      const v = this.resolve(a.ref);
      const dir = a.path || "/";
      if (dir !== "/" && (!v.tree[dir] || v.tree[dir].type !== "dir"))
        refuse("NoSuchPath", `${dir} is not a directory`);
      return {
        kind: "ok",
        snapshot: v.label,
        root: v.root,
        items: childrenOf(v.tree, dir).map((p) => ({
          name: baseName(p),
          path: p,
          type: v.tree[p].type,
          inode: v.tree[p].inode,
        })),
        nextCursor: null,
      };
    },
    "fs.stat"(a) {
      const v = this.resolve(a.ref);
      const e = v.tree[a.path];
      if (!e) refuse("NoSuchPath", `${a.path} does not exist`);
      return {
        kind: "ok",
        snapshot: v.label,
        path: a.path,
        type: e.type,
        inode: e.inode,
        size: (e.content || "").length,
      };
    },
    "fs.grep"(a) {
      const v = this.resolve(a.ref);
      const items = [];
      for (const p of Object.keys(v.tree).sort()) {
        const e = v.tree[p];
        if (e.type !== "file" || !isUnder(p, a.path || "/")) continue;
        e.content.split("\n").forEach((line, i) => {
          if (line.includes(a.pattern)) items.push({ path: p, line: i + 1, text: line.trim() });
        });
      }
      return { kind: "ok", snapshot: v.label, root: v.root, items, nextCursor: null };
    },
    "fs.diff_files"(a) {
      // Current selectors share one captured Branch root.
      const base = this.resolve(a.ref);
      const side = (sel) => {
        const v = sel.commit ? this.resolve(sel.commit) : base;
        const e = v.tree[sel.path];
        if (!e) refuse("NoSuchPath", `${sel.path} does not exist at ${v.label}`);
        if (e.type !== "file") refuse("IsDirectory", `${sel.path} is a directory`);
        return { path: sel.path, snapshot: v.label, inode: e.inode, content: e.content };
      };
      const l = side(a.left),
        r = side(a.right);
      const equal = l.content === r.content;
      return {
        kind: equal ? "Equal" : "Text",
        left: { path: l.path, snapshot: l.snapshot, inode: l.inode },
        right: { path: r.path, snapshot: r.snapshot, inode: r.inode },
        contentEqual: equal,
        sameInode: l.inode === r.inode,
        hunks: equal ? [] : lineDiff(l.content, r.content),
      };
    },

    // ---------------------------------------------------------- fs writes
    "fs.write"(a) {
      return this.mutate(a.branch, [{ kind: "write", path: a.path, content: a.content }], "fs.write", a.message);
    },
    "fs.edit"(a) {
      return this.mutate(
        a.branch,
        [{ kind: "edit", path: a.path, oldText: a.oldText, newText: a.newText, all: a.all }],
        "fs.edit",
        a.message,
      );
    },
    "fs.mkdir"(a) {
      return this.mutate(a.branch, [{ kind: "mkdir", path: a.path, recursive: a.recursive }], "fs.mkdir", a.message);
    },
    "fs.rm"(a) {
      return this.mutate(a.branch, [{ kind: "remove", path: a.path, recursive: a.recursive }], "fs.rm", a.message);
    },
    "fs.cp"(a) {
      return this.mutate(
        a.branch,
        [{ kind: "cp", from: a.from, to: a.to, recursive: a.recursive }],
        "fs.cp",
        a.message,
      );
    },
    "fs.mv"(a) {
      return this.mutate(a.branch, [{ kind: "mv", from: a.from, to: a.to }], "fs.mv", a.message);
    },
    "fs.apply"(a) {
      return this.mutate(a.branch, a.changes, "fs.apply", a.message);
    },

    // ---------------------------------------------------------- sandbox
    "sandbox.create"() {
      const id = "sb_" + String(++this.s.seq.sandbox).padStart(2, "0");
      this.s.sandboxes[id] = {
        id,
        closed: false,
        nextWs: 1,
        workspaces: {},
        wsOrder: [],
        processes: {},
        procOrder: [],
      };
      this.s.sandboxOrder.push(id);
      return { kind: "Ready", id, mounted: false };
    },
    "sandbox.list"() {
      return {
        kind: "ok",
        items: this.s.sandboxOrder.map((id) => {
          const sb = this.s.sandboxes[id];
          return {
            id,
            status: sb.closed ? "closed" : "ready",
            mounts: sb.wsOrder.filter((p) => sb.workspaces[p].mounted),
          };
        }),
      };
    },
    "sandbox.mount"(a) {
      const sb = this.sandbox(a.sandbox);
      const b = this.branch(a.branch);
      const path = "/workspaces/" + sb.nextWs++;
      const root = this.branchRoot(b);
      sb.workspaces[path] = {
        sandbox: sb.id,
        path,
        branch: b.name,
        baseCommit: b.head,
        baseLayer: b.base,
        baseRoot: root,
        live: clone(this.s.roots[root]),
        mounted: true,
        slot: this.slot(),
        times: {},
      };
      sb.wsOrder.push(path);
      return { kind: "Mounted", sandbox: sb.id, path, branch: b.name, base: b.head || b.base, root };
    },
    "sandbox.list_mounts"(a) {
      const sb = this.sandbox(a.sandbox);
      return {
        kind: "ok",
        items: sb.wsOrder
          .filter((p) => sb.workspaces[p].mounted)
          .map((p) => {
            const w = sb.workspaces[p];
            return {
              path: p,
              branch: w.branch,
              base: w.baseCommit || w.baseLayer,
              overlay: diffTrees(this.s.roots[w.baseRoot], w.live).length,
            };
          }),
      };
    },
    "sandbox.exec"(a) {
      const ws = this.workspace(a.sandbox, a.path);
      const sb = this.s.sandboxes[a.sandbox];
      let changed = [];
      let exitCode = a.exitCode ?? 0;
      let stdout = a.output ?? "";
      if (a.writes && a.writes.length) {
        try {
          const before = ws.live;
          ws.live = applyChanges(ws.live, a.writes, () => this.newInode());
          changed = diffTrees(before, ws.live).map((d) => d.path);
          const t = this.tick();
          for (const p of changed) ws.times[p] = t;
        } catch (e) {
          if (!(e instanceof Refusal)) throw e;
          exitCode = 1;
          stdout = e.message;
        }
      }
      if (a.background) {
        const id = "proc_" + String(++this.s.seq.proc).padStart(2, "0");
        sb.processes[id] = { id, path: a.path, command: a.command, status: "running" };
        sb.procOrder.push(id);
        return { kind: "running", process: id, command: a.command, changed };
      }
      return { kind: "exit:" + exitCode, exitCode, stdout, changed };
    },
    "sandbox.list_processes"(a) {
      const sb = this.sandbox(a.sandbox);
      return { kind: "ok", items: sb.procOrder.map((id) => clone(sb.processes[id])) };
    },
    "process.cancel"(a) {
      const sb = this.sandbox(a.sandbox);
      const p = sb.processes[a.process];
      if (!p) refuse("NoSuchProcess", `${a.process} is not owned by ${a.sandbox}`);
      if (p.status !== "running") return { kind: "Stopped", process: p.id, status: p.status };
      p.status = "stopped";
      return { kind: "Stopped", process: p.id, status: "stopped" };
    },
    "sandbox.status"(a) {
      const ws = this.workspace(a.sandbox, a.path);
      const b = this.s.branches[ws.branch];
      return {
        kind: "ok",
        workspace: `${a.sandbox}:${a.path}`,
        branch: ws.branch,
        base: ws.baseCommit || ws.baseLayer,
        branchHead: b.head,
        headMovedSinceMount: b.head !== ws.baseCommit,
        overlay: diffTrees(this.s.roots[ws.baseRoot], ws.live).map((d) => `${d.kind[0]} ${d.path}`),
      };
    },
    // Proposal: two Commit kinds, and commit is the only Workspace verb.
    // Normal: parent = the Branch head. A stale Workspace (head moved since
    // mount or its last Commit) is merged three-way with the head first:
    //   clean    -> a normal Commit on the head (result.merged);
    //   conflict -> refused, nothing committed; the merge is written into the
    //               Workspace (clean files applied, markers in conflicting
    //               files) and its base moves to the head. Fix the markers and
    //               commit again. Commit is refused while a marker block remains.
    // Overwrite (force): commits the Workspace as it is, displacing the head.
    "sandbox.commit"(a) {
      const ws = this.workspace(a.sandbox, a.path);
      const b = this.s.branches[ws.branch];
      const capturedHead = ws.baseCommit;
      const stale = b.head !== capturedHead;
      const markers = this.markersIn(ws);
      if (markers.length)
        refuse(
          "Conflict",
          `${markers.length} ${markers.length === 1 ? "file still contains" : "files still contain"} conflict markers`,
          {
            head: b.head,
            base: capturedHead || ws.baseLayer,
            conflicts: markers.map((p) => ({ path: p, kind: "markers" })),
            lww: [],
            markers: true,
          },
        );
      let merged = null;
      if (stale && !a.force) {
        const theirs = this.s.roots[this.branchRoot(b)];
        const m = this.merge(this.s.roots[ws.baseRoot], ws.live, theirs, {
          labels: ["workspace", `${b.name}@${b.head}`],
          rules: lwwRules(theirs),
          timeOurs: (p) => ws.times[p] || 0,
          timeTheirs: (p) => this.changeTime(b.head, p, capturedHead || ws.baseLayer),
        });
        merged = { from: capturedHead || ws.baseLayer, head: b.head, lww: m.lww };
        if (!m.clean) {
          const changed = diffTrees(ws.live, m.tree).map((d) => d.path);
          ws.live = m.tree;
          ws.baseCommit = b.head;
          ws.baseLayer = b.base;
          ws.baseRoot = this.branchRoot(b);
          refuse(
            "Conflict",
            `${b.name} head moved to ${b.head} and ${m.conflicts.length} ${m.conflicts.length === 1 ? "file conflicts" : "files conflict"} with this Workspace; nothing committed`,
            { head: b.head, base: merged.from, conflicts: m.conflicts, lww: m.lww, written: changed },
          );
        }
        ws.live = m.tree;
      }
      const currentRoot = this.branchRoot(b);
      const root = this.intern(ws.live);
      if (root === currentRoot) {
        ws.baseCommit = b.head;
        ws.baseLayer = b.base;
        ws.baseRoot = root;
        return { kind: "UpToDate", branch: b.name, head: b.head, root, capturedHead, displacedHead: null, merged };
      }
      const id = "C" + ++this.s.seq.commit;
      const displacedHead = stale && a.force ? b.head : null;
      this.s.commits[id] = {
        id,
        parent: a.force ? capturedHead : b.head,
        root,
        base: b.base,
        branch: b.name,
        slot: this.slot(),
        by: "workspace",
        via: `${a.sandbox}:${a.path}`,
        time: this.tick(),
        ...(merged ? { merged } : {}),
        ...(a.message ? { message: a.message } : {}),
      };
      if (displacedHead) this.s.commits[displacedHead].displacedBy = id;
      b.head = id;
      ws.baseCommit = id;
      ws.baseLayer = b.base;
      ws.baseRoot = root;
      return { kind: "Committed", branch: b.name, head: id, root, capturedHead, displacedHead, merged };
    },
    // Proposal: refused while uncommitted changes exist, unless discard.
    "sandbox.unmount"(a) {
      const ws = this.workspace(a.sandbox, a.path);
      const sb = this.s.sandboxes[a.sandbox];
      const busy = sb.procOrder.filter(
        (id) => sb.processes[id].status === "running" && sb.processes[id].path === a.path,
      );
      if (busy.length)
        refuse("Busy", `${a.sandbox}:${a.path} is busy: ${busy.join(", ")} still running`, { processes: busy });
      const changed = diffTrees(this.s.roots[ws.baseRoot], ws.live).map((d) => d.path);
      if (changed.length && !a.discard)
        refuse(
          "Dirty",
          `${a.sandbox}:${a.path} has ${changed.length} uncommitted change${changed.length === 1 ? "" : "s"}`,
          { changed },
        );
      ws.mounted = false;
      return { kind: "Unmounted", workspace: `${a.sandbox}:${a.path}`, discardedUncommitted: changed };
    },
    "sandbox.close"(a) {
      const sb = this.sandbox(a.sandbox);
      const live = sb.wsOrder.filter((p) => sb.workspaces[p].mounted);
      if (live.length)
        refuse("MountsActive", `${sb.id} still has mounted Workspaces: ${live.join(", ")}`, { mounts: live });
      sb.closed = true;
      return { kind: "Closed", id: sb.id };
    },
  };

  function forkFrom(name, baseLayer, fromCommit) {
    if (name === "main") refuse("ReservedName", `"main" names the project's main line`);
    if (this.s.branches[name]) refuse("NameTaken", `Branch ${name} already exists`);
    // A fork from a saved Commit keeps that Commit's base Layer.
    const base = fromCommit ? this.s.commits[fromCommit].base : baseLayer;
    const b = { name, base, head: fromCommit || null, from: fromCommit || baseLayer, slot: this.slot() };
    this.s.branches[name] = b;
    this.s.branchOrder.push(name);
    return { kind: "Forked", branch: name, base, head: b.head, root: this.branchRoot(b) };
  }

  // ---------------------------------------------------------------- scripts
  // Generates the inline Node tool call an agent would send for one step.
  function scriptFor(step, project) {
    const a = step.args || {};
    let target = "layerfs",
      method = step.call,
      args = [];
    switch (method) {
      case "project.init":
        args = [`./${a.name || project}`];
        break;
      case "project.list_branches":
        args = [a.pageSize, a.pagePos];
        break;
      case "main.fork":
        method = "branch.fork";
        args = [a.name, "main"];
        break;
      case "main.list_layers":
        target = "operator";
        method = "inspect.snapshot";
        break;
      case "branch.fork":
        args = [a.name, a.fromCommit || a.branch || "main"];
        break;
      case "branch.list_commits":
        args = [a.branch, a.pageSize, a.pagePos];
        break;
      case "branch.diff_commits":
      case "branch.diff_branches":
        args = [a.from, a.to, a.pageSize, a.pagePos];
        break;
      case "branch.publish":
        args = [a.branch, a.commit];
        break;
      case "branch.merge":
        args = [a.branch, a.with, a.name, a.message];
        break;
      case "fs.read":
        args = [a.commit || a.ref, a.path, a.startLine, a.endLine];
        break;
      case "fs.list":
        args = [a.ref, a.path || "/", a.pageSize, a.pagePos];
        break;
      case "fs.stat":
        args = [a.ref, a.path];
        break;
      case "fs.grep":
      case "fs.glob":
        args = [a.ref, a.pattern, a.path || "/", a.pageSize, a.pagePos];
        break;
      case "fs.blame":
        args = [a.commit || a.ref, a.path, a.fromLine];
        break;
      case "fs.diff_files":
        args = [a.left.commit || a.ref, a.left.path, a.right.commit || a.ref, a.right.path];
        break;
      case "fs.write":
        args = [a.branch, a.path, a.content, a.message];
        break;
      case "fs.edit":
        args = [a.branch, a.path, a.oldText, a.newText, a.message];
        break;
      case "fs.mkdir":
      case "fs.rm":
        args = [a.branch, a.path, a.message];
        break;
      case "fs.cp":
      case "fs.mv":
        args = [a.branch, a.from, a.to, a.message];
        break;
      case "fs.apply":
        args = [
          a.branch,
          a.changes.map(({ kind, ...rest }) => ({ op: kind === "remove" ? "rm" : kind, ...rest })),
          a.message,
        ];
        break;
      case "sandbox.create":
        args = [a.name || "box-1", project, { raw: "process.env.LAYERFS_IMAGE" }];
        break;
      case "sandbox.mount":
        args = [a.sandbox, a.branch];
        break;
      case "sandbox.status":
        args = [a.sandbox, a.path];
        break;
      case "sandbox.close":
        args = [a.sandbox];
        break;
      case "sandbox.exec":
        args = [a.sandbox, a.path, a.command, a.message];
        if (a.background) {
          target = "operator";
          method = "process.start";
          args = args.slice(0, 3);
        }
        break;
      case "sandbox.list_processes":
        target = "operator";
        method = "process.list";
        args = [a.sandbox];
        break;
      case "process.cancel":
        target = "operator";
        args = [a.sandbox, a.process];
        break;
      case "sandbox.commit":
        args = [a.sandbox, a.path, a.message, !!a.force];
        break;
      case "sandbox.unmount":
        args = [a.sandbox, a.path, !!a.discard];
        break;
      default:
        return `// ${method} is a UI action`;
    }
    while (args.length && args[args.length - 1] === undefined) args.pop();
    const imports = target === "operator" ? '\nimport { LayerFSOperator } from "@layerfs/sdk/operator";' : "";
    return `node --input-type=module <<'JS'\nimport { LayerFS } from "@layerfs/sdk";${imports}\nconst layerfs = new LayerFS(${J(project)});\n${target === "operator" ? "const operator = new LayerFSOperator(layerfs);\n" : ""}const result = await ${target}.${method}(${args.map((v) => (v === undefined ? "undefined" : v && v.raw ? v.raw : J(v))).join(", ")});\nconsole.log(JSON.stringify(result));\nJS`;
  }

  // ---------------------------------------------------------------- scenarios
  // Runs every step on a fresh model; records outcome, snapshot and the check.
  function runScenario(scn) {
    const sim = new Sim();
    const steps = [];
    const initial = sim.snapshot();
    for (const [i, st] of scn.steps.entries()) {
      const before = sim.snapshot();
      const outcome = sim.run(st.call, st.args);
      const after = sim.snapshot();
      let pass = outcome.code === st.expect;
      let why = pass ? "" : `expected ${st.expect}, got ${outcome.code}`;
      if (pass && st.check) {
        try {
          const r = st.check(outcome.result || outcome.refusal, after);
          if (r !== true) {
            pass = false;
            why = typeof r === "string" ? r : "check failed";
          }
        } catch (e) {
          pass = false;
          why = "check threw: " + e.message;
        }
      }
      steps.push({ index: i, ...st, outcome, before, after, pass, why, script: scriptFor(st, scn.project) });
    }
    return { scenario: scn, initial, steps, sim };
  }

  const api = {
    Sim,
    Refusal,
    applyChanges,
    diffTrees,
    lineDiff,
    merge3Lines,
    merge3Trees,
    lwwRules,
    hasMarkers,
    treeKey,
    scriptFor,
    runScenario,
    childrenOf,
    parentOf,
    baseName,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.LayerSim = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
