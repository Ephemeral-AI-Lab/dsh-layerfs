// Read-side helpers for the Files pane and the fs `blame` command.
// Refs: "main", a Branch name, "C3", "L1", or "fork:<branch>" (a fork point).
// Blame is composed client-side from saved versions (branch.list_commits +
// fs.read per version); the SDK has no blame call yet (proposed: fs.blame).
(function (global) {
  "use strict";
  const M = typeof module !== "undefined" && module.exports ? require("./model.js") : global.LayerSim;

  // { ref, label, tree, node } where node is the graph node the ref points at.
  function resolveRef(sim, ref) {
    const s = sim.s;
    if (ref && ref.startsWith("fork:")) {
      const b = s.branches[ref.slice(5)];
      if (!b) return null;
      const node = b.from;
      const root = /^C\d+$/.test(node) ? s.commits[node].root : s.layers[node].root;
      return { ref, label: `${b.name} fork point (${node})`, tree: s.roots[root], node };
    }
    try {
      const v = sim.resolve(ref);
      if (v.kind === "live") return null;
      const node = v.kind === "main" ? s.main.head : v.kind === "branch" ? v.head || s.branches[ref].from : ref;
      return { ref, label: v.label, tree: v.tree, node };
    } catch (e) {
      return null;
    }
  }

  // The ref one step back: a Commit's parent (or its Branch's fork point),
  // a Layer's parent, a Branch head's parent.
  function parentRef(sim, ref) {
    const s = sim.s,
      r = resolveRef(sim, ref);
    if (!r) return null;
    const id = r.node;
    if (s.commits[id]) {
      const c = s.commits[id];
      if (c.parent && s.commits[c.parent].branch === c.branch) return c.parent;
      return "fork:" + c.branch;
    }
    if (s.layers[id]) return s.layers[id].parent || null;
    return null;
  }

  // Saved versions behind a ref, newest first. A Commit walks its parents
  // (across a fork into the source Branch), then its base Layer and main's
  // Layers. A published Layer continues through its source Commit, so main's
  // lines are credited to the Commit that wrote them.
  function chainOf(sim, ref) {
    const s = sim.s,
      r = resolveRef(sim, ref);
    if (!r) return [];
    const out = [],
      seen = new Set();
    let id = r.node;
    while (id && !seen.has(id)) {
      seen.add(id);
      if (s.commits[id]) {
        const c = s.commits[id];
        out.push({ id, kind: "commit", branch: c.branch, by: c.by, via: c.via, root: c.root });
        id = c.parent || c.base;
      } else if (s.layers[id]) {
        const l = s.layers[id];
        if (l.sourceCommit && !seen.has(l.sourceCommit)) {
          id = l.sourceCommit;
          continue;
        }
        out.push({
          id,
          kind: "layer",
          branch: "main",
          via: l.sourceCommit ? `published from ${l.sourceCommit}` : "project.init",
          root: l.root,
        });
        id = l.parent;
      } else break;
    }
    return out;
  }

  // Each line of `path` at `ref`, with the oldest saved version in the chain
  // from which the line is unchanged.
  function blame(sim, ref, path) {
    const s = sim.s,
      chain = chainOf(sim, ref);
    const text = (n) => {
      const e = s.roots[n.root][path];
      return e && e.type === "file" ? e.content : null;
    };
    if (!chain.length || text(chain[0]) == null) return null;
    const lines = text(chain[0]).split("\n");
    const track = lines.map((_, i) => i),
      owner = new Array(lines.length).fill(null);
    let open = lines.length;
    for (let k = 0; k < chain.length && open; k++) {
      const cur = chain[k],
        older = chain[k + 1],
        curText = text(cur),
        oldText = older ? text(older) : null;
      if (oldText == null) {
        for (let i = 0; i < lines.length; i++) if (!owner[i]) owner[i] = cur;
        break;
      }
      if (oldText === curText) continue;
      const map = {};
      let ci = 0,
        oi = 0;
      for (const op of M.lineDiff(oldText, curText)) {
        if (op.op === " ") {
          map[ci] = oi;
          ci++;
          oi++;
        } else if (op.op === "+") ci++;
        else oi++;
      }
      for (let i = 0; i < lines.length; i++) {
        if (owner[i]) continue;
        const j = map[track[i]];
        if (j === undefined) {
          owner[i] = cur;
          open--;
        } else track[i] = j;
      }
    }
    return { versions: chain.length, lines: lines.map((t, i) => ({ n: i + 1, text: t, origin: owner[i] })) };
  }

  // The saved versions of `path` behind a ref where it changed, newest first:
  // { node, change: "A" | "M" | "D", content }. A preview of a file-history
  // read (issue #329); live trees load lazily, so early answers can be short.
  function history(sim, ref, path) {
    const s = sim.s,
      chain = chainOf(sim, ref),
      out = [];
    const text = (n) => {
      const e = n && s.roots[n.root] && s.roots[n.root][path];
      return e && e.type === "file" ? e.content : null;
    };
    for (let k = 0; k < chain.length; k++) {
      const cur = text(chain[k]),
        old = text(chain[k + 1]);
      if (cur === old) continue;
      out.push({ node: chain[k], change: cur == null ? "D" : old == null ? "A" : "M", content: cur });
    }
    return out;
  }

  // path -> "A" | "M" | "D" from base to subject, plus folder roll-ups.
  function changeMap(subjectTree, baseTree) {
    const files = {},
      dirs = {};
    for (const d of M.diffTrees(baseTree, subjectTree)) {
      if (d.type === "dir" && d.kind === "Modified") continue;
      files[d.path] = d.kind === "Added" ? "A" : d.kind === "Removed" ? "D" : "M";
      for (let p = M.parentOf(d.path); p && p !== "/"; p = M.parentOf(p)) dirs[p] = (dirs[p] || 0) + 1;
    }
    return { files, dirs, count: Object.keys(files).length };
  }

  // Children of `dir` present in either tree, folders first.
  function listBoth(subjectTree, baseTree, dir) {
    const set = new Set(M.childrenOf(subjectTree, dir));
    if (baseTree) for (const p of M.childrenOf(baseTree, dir)) set.add(p);
    const typeOf = (p) => (subjectTree[p] || baseTree[p]).type;
    return [...set]
      .sort((a, b) => (typeOf(a) === typeOf(b) ? a.localeCompare(b) : typeOf(a) === "dir" ? -1 : 1))
      .map((p) => ({ path: p, name: M.baseName(p), type: typeOf(p), gone: !subjectTree[p] }));
  }

  const api = { resolveRef, parentRef, chainOf, blame, history, changeMap, listBoth };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.LayerFiles = api;
})(this);
