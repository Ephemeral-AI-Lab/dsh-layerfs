// The simulator backend: the model (model.js) behind an asynchronous SDK-shaped
// surface. Shell commands are simulated
// (terminal.js simulateShell), so `simulated` is true.
(function (global) {
  "use strict";
  const M = typeof module !== "undefined" && module.exports ? require("../model.js") : global.LayerSim;

  class SimBackend {
    constructor() {
      this.sim = new M.Sim();
      this.live = false;
      this.simulated = true;
      this.onchange = null;
      this.packed = new Map();
      this.packing = new Set();
    }
    /** Stored bytes of one content, estimated with the browser's deflate as a
     *  stand-in for the product's zstd (no deltas): the smaller of raw and
     *  deflated, as the product keeps STORED when compression does not help.
     *  Computed asynchronously; null until ready, then `onchange` fires. */
    storedSize(text) {
      if (this.packed.has(text)) return this.packed.get(text);
      if (typeof CompressionStream === "undefined" || typeof Response === "undefined") return null;
      if (!this.packing.has(text)) {
        this.packing.add(text);
        const raw = new TextEncoder().encode(text);
        new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer().then((b) => {
          this.packed.set(text, Math.min(raw.length, b.byteLength));
          this.packing.delete(text);
          clearTimeout(this.wake);
          this.wake = setTimeout(() => this.onchange && this.onchange(), 30);
        });
      }
      return null;
    }
    get s() { return this.sim.s; }
    set s(world) { this.sim.s = world; }
    /** A fresh project: Init of `files` as main's first Layer. */
    async reset(files) {
      this.sim = new M.Sim();
      return this.sim.run("project.init", { name: "website", files });
    }
    /** One call; the outcome envelope of Sim.run. */
    /** One call, timed in the page: simulated, so its time says nothing about the product. */
    async run(name, args) {
      const started = performance.now();
      const outcome = this.sim.run(name, args);
      outcome.timing = { totalMs: performance.now() - started, simulated: true };
      return outcome;
    }
    /** Store size estimated from the model (a preview of issue #329 D):
     *  logical counts a file in every saved root it is in; payload counts each
     *  distinct content once; metadata assumes 64 bytes per distinct entry and
     *  256 per Commit or Layer record. */
    storage() {
      const s = this.sim.s, bytes = (t) => (typeof Buffer !== "undefined" ? Buffer.byteLength(t) : new TextEncoder().encode(t).length);
      const seen = new Set(), entries = new Set();
      let logical = 0, payload = 0, stored = 0, pending = false;
      for (const root of Object.values(s.roots)) {
        for (const [path, e] of Object.entries(root)) {
          entries.add(`${path}\0${e.type}\0${e.content ?? ""}`);
          if (e.type !== "file") continue;
          const n = bytes(e.content || "");
          logical += n;
          if (!seen.has(e.content)) {
            seen.add(e.content); payload += n;
            const z = this.storedSize(e.content || "");
            if (z == null) { pending = true; stored += n; } else stored += z;
          }
        }
      }
      const metadata = entries.size * 64 + (Object.keys(s.commits).length + Object.keys(s.layers).length) * 256;
      return { estimate: true, logical, payload, stored, pending, metadata, store: stored + metadata };
    }
    /** One mounted Workspace's overlay, estimated from the model: the changed
     *  files' bytes as payload, 64 bytes per changed entry as metadata. */
    overlayOf(ws) {
      if (!ws || !ws.live) return null;
      const out = { estimate: true, added: 0, modified: 0, removed: 0, payload: 0, metadata: 0 };
      for (const d of M.diffTrees(this.sim.s.roots[ws.baseRoot], ws.live)) {
        out[d.kind === "Added" ? "added" : d.kind === "Removed" ? "removed" : "modified"]++;
        out.metadata += 64;
        const e = ws.live[d.path];
        if (e && e.type === "file") out.payload += new TextEncoder().encode(e.content || "").length;
      }
      return out;
    }
    liveMountsOf(branch) { return this.sim.liveMountsOf(branch); }
    resolve(ref) { return this.sim.resolve(ref); }
    markersIn(ws) { return this.sim.markersIn(ws); }
    dirtyOf(ws) { return M.diffTrees(this.sim.s.roots[ws.baseRoot], ws.live).length; }
    async poll() { return false; }
    async close() {}
  }

  const api = { SimBackend };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.LayerBackendSim = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
