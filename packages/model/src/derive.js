// The engine state reshaped for the views: graph nodes with their author,
// Branch rows, and the mounted Workspaces an agent owns. Rebuilt after
// every event from `W.engine.s`, which every engine keeps in the
// simulator's shape (model.js `Sim.s`).

/** Branch lane colours, by Branch order. */
export const BCOL = ["--b0", "--b1", "--b2", "--b3", "--b4", "--b5"];

export const branchRoot = (s, b) => (b.head ? s.commits[b.head].root : s.layers[b.base].root);
/** The engine's Workspace for a pane key "sb_01:/workspaces/2". */
export const engWs = (s, k) => {
  const i = k.indexOf(":"),
    sb = s.sandboxes[k.slice(0, i)];
  return sb && sb.workspaces[k.slice(i + 1)];
};

export function derive(W) {
  const s = W.engine.s,
    nodes = {};
  W.mainHead = s.main ? s.main.head : null;
  W.order = s.branchOrder.slice();
  W.initLayer = (Object.values(s.layers).find((l) => !l.parent) || {}).id;
  for (const l of Object.values(s.layers))
    nodes[l.id] = {
      id: l.id,
      kind: "layer",
      branch: null,
      parents: [l.parent, l.sourceCommit || null],
      t: l.slot,
      by: W.attrib[l.id],
      msg: l.sourceBranch ? `publish ${l.sourceBranch}@${l.sourceCommit}` : `init ${s.project ? s.project.name : ""}`,
    };
  for (const name of s.branchOrder) {
    const b = s.branches[name];
    nodes["fork:" + name] = {
      id: "fork:" + name,
      kind: "fork",
      branch: name,
      parents: [b.from],
      t: b.slot,
      by: W.attrib["fork:" + name],
      msg: `fork ← ${b.from}`,
    };
  }
  for (const c of Object.values(s.commits)) {
    const own = c.parent && s.commits[c.parent] && s.commits[c.parent].branch === c.branch;
    // demo commit messages already start with "<agent>: "; the label adds the agent itself
    const by = W.attrib[c.id],
      raw = c.message || c.via || "",
      msg = by && raw.startsWith(`${by}: `) ? raw.slice(by.length + 2) : raw;
    nodes[c.id] = {
      id: c.id,
      kind: "commit",
      branch: c.branch,
      parents: [own ? c.parent : "fork:" + c.branch, c.mergedFrom || null],
      t: c.slot,
      by,
      msg,
    };
  }
  W.nodes = nodes;
  W.branches = {};
  s.branchOrder.forEach((name, i) => {
    const b = s.branches[name];
    W.branches[name] = {
      name,
      color: BCOL[i % BCOL.length],
      head: b.head || "fork:" + name,
      base: b.from,
      last: W.touched[name] ?? 0,
      published: !!b.head && Object.values(s.layers).some((l) => l.sourceBranch === name && l.sourceCommit === b.head),
    };
  });
  W.ws = {};
  for (const id of s.sandboxOrder)
    for (const p of s.sandboxes[id].wsOrder) {
      const w = s.sandboxes[id].workspaces[p],
        k = `${id}:${p}`,
        pane = W.panes[k];
      // A Workspace no agent event mounted (another client of the same
      // project) has no agent to attribute it to, so it is not drawn.
      if (!w.mounted || !pane) continue;
      W.ws[k] = {
        id: k,
        agent: pane.agent,
        branch: w.branch,
        lines: pane.lines,
        born: pane.born,
        bad: W.engine.markersIn(w).length > 0,
        baseNode: w.baseCommit || "fork:" + w.branch,
        eng: w,
      };
    }
  return W;
}

/** Root of every ref (main and each Branch), to find what a step changed. */
export function rootsOf(W) {
  const s = W.engine.s,
    out = {};
  if (s.main) out.main = s.layers[s.main.head].root;
  for (const b of s.branchOrder) out[b] = branchRoot(s, s.branches[b]);
  return out;
}

/** Paths each ref changed between two `rootsOf` snapshots. Trees load
 * lazily on live engines: a ref only flashes when both of its trees are
 * already here (`loaded(root, W)`). `diffTrees` is model.js's. */
export function changedPaths(W, before, after, { diffTrees, loaded = () => true }) {
  const out = {},
    roots = W.engine.s.roots;
  for (const [ref, root] of Object.entries(after))
    if (before[ref] && root && before[ref] !== root && loaded(before[ref], W) && loaded(root, W))
      out[ref] = new Set(diffTrees(roots[before[ref]], roots[root]).map((d) => d.path));
  return out;
}
