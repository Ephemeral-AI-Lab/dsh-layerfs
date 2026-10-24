// The live read model in the simulator's shape (model.js `Sim.s`), built from
// `inspect.snapshot` and the answers of the calls the server made.
//
// Display ids: Commits are C1, C2, … and Layers L0, L1, … in the order they
// were made; roots are R0, R1, …; a project's numbered Sandbox n is
// layerfs-<project>-n, as its container is named (#373), and an older
// trace's opaque Sandbox id sb_01, sb_02, …. Real ids never
// reach the UI, and ids the UI sends are mapped back before an SDK call.
// Commits and Layers are immutable, so the mirror keeps every one it has seen
// even after a snapshot pages it out.

export class Mirror {
  constructor() {
    this.toLabel = new Map();
    this.toReal = new Map();
    this.next = { C: 1, L: 0, R: 0, sb: 1 };
    this.slot = 0;
    this.version = 0;
    /** The project, for its numbered Sandboxes' labels. */
    this.project = null;
    this.s = {
      project: null,
      main: null,
      roots: {},
      commits: {},
      layers: {},
      branches: {},
      branchOrder: [],
      sandboxes: {},
      sandboxOrder: [],
    };
  }

  // ------------------------------------------------------------ ids
  label(kind, real) {
    if (real === null || real === undefined) return null;
    const known = this.toLabel.get(real);
    if (known) return known;
    const n = this.next[kind]++;
    // a numbered Sandbox is named as its container; a named one keeps its
    // name; an older opaque sb_<hex> id gets sb_01, sb_02, …
    const label =
      kind !== "sb"
        ? `${kind}${n}`
        : /^\d+$/.test(real) && this.project
          ? `layerfs-${this.project}-${real}`
          : /^sb_[0-9a-f]{16,}$/.test(real)
            ? `sb_${String(n).padStart(2, "0")}`
            : real;
    this.toLabel.set(real, label);
    this.toReal.set(label, real);
    return label;
  }
  /** A node id (Commit or Layer) the UI knows, or null. */
  node(real) {
    return real ? (this.toLabel.get(real) ?? null) : null;
  }
  root(real) {
    return this.label("R", real);
  }
  real(label) {
    return this.toReal.get(label) ?? label;
  }
  /** A Commit id first seen in an answer: labelled now, recorded on refresh. */
  commitLabel(real) {
    return this.label("C", real);
  }
  bump() {
    this.version++;
  }

  // ------------------------------------------------------------ snapshot
  /** Folds one `inspect.snapshot` answer (kind "ok") into the mirror. */
  absorb(snap, sandboxes) {
    const s = this.s,
      before = JSON.stringify(s);
    s.project = { name: snap.project };
    s.store = snap.store;
    // Commit labels follow the order Commits were made, before a Layer names one.
    for (const c of [...snap.commits].sort((a, b) => a.time - b.time)) this.commitLabel(c.id);
    // Layers: the snapshot lists main's chain newest first.
    for (const l of [...snap.layers].reverse()) this.absorbLayer(l);
    const main = snap.branches.find((b) => b.name === "main");
    if (main) s.main = { head: this.label("L", main.base) };
    // Commits: in the order they were made.
    for (const c of [...snap.commits].sort((a, b) => a.time - b.time)) this.absorbCommit(c);
    for (const b of snap.branches) {
      if (b.name === "main") continue;
      const known = s.branches[b.name];
      const base = this.label("L", b.base),
        head = this.node(b.head) ?? (b.head ? this.commitLabel(b.head) : null);
      const from = this.node(b.forkedFrom) ?? base;
      if (!known) {
        s.branches[b.name] = { name: b.name, base, head, from, slot: this.slot++ };
        s.branchOrder.push(b.name);
      } else Object.assign(known, { base, head, from });
    }
    this.absorbWorkspaces(snap, sandboxes);
    // A poll that finds nothing new keeps the version, so the page does not redraw.
    if (JSON.stringify(s) !== before) this.bump();
  }
  absorbLayer(l) {
    const id = this.label("L", l.id);
    if (this.s.layers[id]) return;
    this.s.layers[id] = {
      id,
      parent: this.node(l.parent),
      root: this.root(l.root),
      sourceBranch: l.sourceBranch ?? null,
      sourceCommit: l.sourceCommit ? this.commitLabel(l.sourceCommit) : null,
      logical: l.logical ?? null,
      slot: this.slot++,
      time: this.slot,
    };
  }
  absorbCommit(c) {
    const id = this.commitLabel(c.id);
    if (this.s.commits[id]) {
      return;
    }

    const record = {
      id,
      parent: this.node(c.parent),
      root: this.root(c.root),
      base: this.label("L", c.base),
      branch: c.branch,
      slot: this.slot++,
      time: c.time,
      by: c.via === "fs" ? "fs" : c.via === "merge" ? "merge" : "workspace",
      via: c.via === "exec" ? "commit" : c.via,
      message: c.message,
      logical: c.logical,
      newCanonical: c.newCanonical,
      newStored: c.newStored,
      newMetadata: c.newMetadata,
    };
    if (c.secondParent) {
      record.mergedFrom = this.node(c.secondParent);
      record.lww = this.ids(c.lww || []);
    }
    if (c.mergedFrom)
      record.merged = { from: this.node(c.mergedFrom), head: record.parent, lww: this.ids(c.lww || []) };
    if (c.displaced) {
      const displaced = this.commitLabel(c.displaced);
      if (this.s.commits[displaced]) this.s.commits[displaced].displacedBy = id;
    }
    this.s.commits[id] = record;
  }
  absorbWorkspaces(snap, sandboxes) {
    const s = this.s;
    for (const sb of sandboxes) {
      const id = sb.label;
      s.sandboxes[id] ||= { id, closed: false, workspaces: {}, wsOrder: [], processes: {}, procOrder: [] };
      if (!s.sandboxOrder.includes(id)) s.sandboxOrder.push(id);
      const box = s.sandboxes[id];
      box.closed = sb.closed;
      for (const path of box.wsOrder) box.workspaces[path].mounted = false;
      const views = (snap.sandboxes.find((x) => x.id === sb.real) || { workspaces: [] }).workspaces;
      for (const w of views) {
        if (!w.mounted || !w.directory) continue;
        const path = w.directory;
        const tracked = sb.workspaces[path] || {};
        const ws = (box.workspaces[path] ||= { sandbox: id, path, slot: this.slot++, times: {} });
        if (!box.wsOrder.includes(path)) box.wsOrder.push(path);
        const dirty = w.dirty ? Math.max(w.dirty.inodes, w.dirty.entries) : 0;
        Object.assign(ws, {
          branch: w.branch,
          baseCommit: this.node(w.base),
          baseLayer: this.label("L", w.baseLayer),
          baseRoot: this.root(w.root),
          mounted: true,
          live: null,
          dirty,
          overlay: tracked.overlay ?? null,
          pendingMerge: w.pendingMerge,
          stale: w.headMovedSinceMount === true,
          markers: (tracked.changes?.items || []).filter((c) => c.markers).map((c) => c.path),
          changes: tracked.changes,
        });
      }
      box.processes = {};
      box.procOrder = [];
      for (const p of sb.processes) {
        box.processes[p.id] = { id: p.id, path: p.path, command: p.command, status: p.status };
        box.procOrder.push(p.id);
      }
    }
  }

  /** Branches mounted by Workspaces: `sb:/workspaces/N` keys, like Sim.liveMountsOf. */
  liveMountsOf(branch) {
    const out = [];
    for (const id of this.s.sandboxOrder) {
      const sb = this.s.sandboxes[id];
      if (sb.closed) continue;
      for (const p of sb.wsOrder)
        if (sb.workspaces[p].mounted && sb.workspaces[p].branch === branch) out.push(`${id}:${p}`);
    }
    return out;
  }

  // ------------------------------------------------------------ answers
  /** Text with every known Commit, Layer or Sandbox id shown as its display
   *  id (conflict markers name a Commit; refusals name a Sandbox). */
  text(value) {
    return typeof value === "string"
      ? value.replace(/\b(?:[0-9a-f]{66}|sb_[0-9a-f]+)\b/g, (id) => this.toLabel.get(id) ?? id)
      : value;
  }
  /** Maps every real id inside an SDK answer to its display id. */
  ids(value) {
    if (Array.isArray(value)) return value.map((v) => this.ids(v));
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.ids(v)]));
    if (typeof value === "string" && /^[0-9a-f]{64,68}$/.test(value)) {
      if (this.toLabel.has(value)) return this.toLabel.get(value);
      if (value.length === 64) return this.root(value);
      return value.startsWith("12") ? this.commitLabel(value) : this.label("L", value);
    }
    return value;
  }
}
