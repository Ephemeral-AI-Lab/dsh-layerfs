// History as a tree, in the design of the LayerFS website's demo (Trace.jsx in
// layerfs-website). It stands upright (time runs up, Branches grow out to both
// sides) or lies on its side (time runs right). main is the green middle
// bough, a little thicker than the rest, with a band for each Layer in the
// colour of the Branch that published it. Each Branch is a bough in its own
// colour that sprouts from the node it was forked from and ends at its head,
// tagged with its name; every Commit is a leaf on it. A merge grafts back with
// a ring, a publish is a dashed stem into a band, and a Branch nobody is on is
// a bare twig past its head with an outlined tag.
// Time is the order of events (node slots), not the wall clock: one step per
// event, so a quiet minute takes no room. Lying on its side (the default) it
// grows like the release video: the view holds the whole run (at least
// GROW_MIN steps) and zooms out as it grows, until a step would be under
// PX_FLOOR px (about a leaf); from then on it scrolls, "now" at the right,
// and the zoom's fit shows it all. Branches are packed
// into lanes: a Branch forked from main takes the free lane nearest main, one
// forked from a Branch the free lane nearest its parent, and keeps it; a lane
// is free again once its Branch has stopped and its tag is behind the new
// fork. Forks, merges and publishes bend where they happen, about 45°;
// merges and publishes are faint but for the open tab's Branch and the one
// under the pointer. Every node keeps its data-node, so the hover card and Files work.
import { esc } from "./util.js";

/** A Commit is a leaf: anchored on its bough at 0,0, pointing along +x. */
export const LEAF = "M0 0Q7 -7.5 15 0Q7 7.5 0 0Z";
// a bend runs about as far along time as the rows it crosses (near 45°), so it
// stays where its event is: never a long diagonal, never a sheer drop
const bendOf = (dr, span) => Math.min(span, Math.max(18, Math.min(220, Math.abs(dr) * 1.1)));
const SPROUT = 40, MAIN_TH = 6.5, TAG_H = 14, CH_W = 6.2, AV = 16;
const GROW_MIN = 24, PX_FLOOR = 10, PX_MAX = 64; // a step never shrinks below about a leaf's width
const LANE_MIN = 24, LANE_MAX = 44, COL_MIN = 34, COL_MAX = 64; // a lane lying down; a column upright

/**
 * A tree renderer. It remembers each Branch's lane, so a Branch keeps its
 * place as the history grows; a stopped Branch's lane is reused.
 * @returns {(W: object, o: object) => {svg: string, overview: string}}
 */
export function createTree() {
  const laneOf = {};
  /**
   * @param {object} W the model's view
   * @param {object} o
   * @param {boolean} o.upright time runs up (else right)
   * @param {number} o.width the panel's width in px
   * @param {number} o.height the panel's height in px
   * @param {string} o.active the open tab: its lane is banded
   * @param {string|null} o.selected the node Files shows, ringed
   * @param {(b: string) => string[]} o.agentsOn agents on a Branch now
   * @param {(n: string) => string} o.head an agent's head as SVG at 0,0 (16 px)
   * @param {(b: string) => boolean} o.idle nobody is on the Branch: a bare twig
   * @param {(b: string) => boolean} [o.stopped] the Branch has stopped: its lane frees past its tag (default: idle)
   */
  return function tree(W, o) {
    const B = W.branches, N = W.nodes;
    const parentOf = (b) => (N[B[b].base] && N[B[b].base].branch) || "main";
    // ---------------------------------------------------------- time
    // one step per distinct slot: every node stands at its own time, so a Branch
    // never runs ahead of the one it was forked from
    const slots = [...new Set(Object.values(N).map((n) => n.t))].sort((a, b) => a - b), rank = new Map(slots.map((t, i) => [t, i]));
    const room = (o.upright ? o.height - 90 : o.width - 150), steps = Math.max(1, slots.length);
    // lying down, the run fills the room with "now" at 92% of it, and zooms out as it grows
    const px = o.upright ? Math.max(14, Math.min(PX_MAX, room / steps)) : Math.max(PX_FLOOR, Math.min(PX_MAX, room / Math.max(GROW_MIN, steps / 0.92)));
    const T0 = 10, T = (n) => T0 + rank.get(n.t) * px, lastT = T0 + (steps - 1) * px;
    const pos = {}, forkT = {}, baseT = {}, headT = {};
    for (const n of Object.values(N)) if (n.kind === "layer") pos[n.id] = T(n);
    const mainHead = W.mainHead && pos[W.mainHead] !== undefined ? pos[W.mainHead] : T0;
    // A Branch's fork point stands at its fork, or later for the room its sprout
    // wants (sproutOf: first the least, then, once the rows are known, what its
    // bend across them needs), but never past its first Commit (with none, two
    // steps past its fork) or the newest step: the sprout takes only the time
    // before the Branch's own work.
    const string = (sproutOf) => { for (const b of W.order) {
      const base = N[B[b].base], fork = N["fork:" + b];
      baseT[b] = base && pos[base.id] !== undefined ? pos[base.id] : base ? T(base) : T(fork);
      const cs = Object.values(N).filter((n) => n.kind === "commit" && n.branch === b).sort((x, y) => x.t - y.t);
      const room = (cs.length ? T(cs[0]) - 8 : Math.min(lastT, T(fork) + 2 * px)) - baseT[b];
      forkT[b] = Math.max(T(fork), baseT[b] + Math.min(sproutOf(b), Math.max(14, room)));
      pos[fork.id] = forkT[b];
      // each Commit at its time, past the fork point; none past the newest step
      let prev = forkT[b] + 8 - px;
      for (const c of cs) prev = pos[c.id] = Math.max(T(c), prev + px);
      let next = Math.max(lastT, forkT[b] + 8);
      for (let i = cs.length - 1; i >= 0; i--) { next = pos[cs[i].id] = Math.min(pos[cs[i].id], next); next -= px; }
      headT[b] = Math.max(forkT[b], pos[B[b].head] ?? forkT[b]);
    } };
    string(() => SPROUT);

    // ---------------------------------------------------------- rows
    // A row (a column, upright) is a lane: a Branch forked from another takes
    // the free lane nearest its parent, on its parent's side, so its fork
    // crosses no other bough; one forked from main the free lane nearest main,
    // on the side with fewer Branches still going. It keeps the lane (laneOf). A
    // lane is held from a Branch's fork past its tag, its last merge or publish
    // out and its last child's fork; while the Branch goes on, for good.
    const kids = {}, depthOf = {};
    for (const b of W.order) (kids[parentOf(b)] ||= []).push(b);
    const build = (b, depth) => { depthOf[b] = depth; for (const k of kids[b] || []) build(k, depth + 1); };
    for (const b of kids.main || []) build(b, 0);
    const tagW = (name) => name.length * CH_W + 8;
    const stopped = o.stopped || o.idle;
    const until = {};
    for (const b of W.order) until[b] = stopped(b) ? headT[b] + tagW(b) + 18 : Infinity;
    for (const n of Object.values(N)) { const src = n.parents[1] && N[n.parents[1]]; if (src && src.branch && until[src.branch] !== undefined && pos[n.id] !== undefined) until[src.branch] = Math.max(until[src.branch], pos[n.id] + 8); }
    for (const b of W.order) { const p = parentOf(b); if (p !== "main") until[p] = Math.max(until[p], baseT[b] + 8); }
    const live = { 1: 0, [-1]: 0 }, seen = [];
    for (const b of [...W.order].sort((x, y) => baseT[x] - baseT[y] || W.order.indexOf(x) - W.order.indexOf(y))) {
      let l = laneOf[b];
      if (l === undefined) {
        const busy = new Set(seen.filter((x) => until[x] > baseT[b]).map((x) => laneOf[x]));
        const pl = laneOf[parentOf(b)] ?? 0, side = Math.sign(pl) || (live[1] <= live[-1] ? 1 : -1);
        if (pl) for (let k = 1; l === undefined; k++) l = [pl + side * k, pl - side * k].find((c) => Math.sign(c) === side && !busy.has(c));
        else for (let d = 1; l === undefined; d++) l = !busy.has(side * d) ? side * d : !busy.has(-side * d) ? -side * d : undefined;
        laneOf[b] = l;
      }
      seen.push(b);
      if (!stopped(b)) live[Math.sign(l)] += 1;
    }
    const lanes = W.order.map((b) => laneOf[b]), nUp = Math.max(0, ...lanes), nDown = Math.max(0, ...lanes.map((l) => -l));
    const rowOf = { main: nUp };
    for (const b of W.order) rowOf[b] = nUp - laneOf[b];
    const nRows = nUp + 1 + nDown;

    // ---------------------------------------------------------- name tags
    // a tag stands past its lane's head; upright, tags that would cover one
    // another climb, each with a leader down to its head
    const COL = o.upright ? Math.max(COL_MIN, Math.min(COL_MAX, (o.width - 40) / Math.max(1, nRows))) : Math.max(LANE_MIN, Math.min(LANE_MAX, (o.height - 40) / Math.max(1, nRows)));
    string((b) => Math.max(SPROUT, bendOf(Math.abs(rowOf[b] - rowOf[parentOf(b)]) * COL, Infinity)));
    const nowT = Math.max(mainHead, lastT, ...W.order.map((b) => forkT[b])) + px * 0.6 + 8;
    // main reaches the newest step, so no Branch is ever ahead of it, but it only grows
    // solid with a publish: past its newest Layer it runs on as a thin dotted line
    const mainEnd = Math.max(mainHead + 12, Math.min(nowT - 4, Math.max(lastT, ...W.order.map((b) => forkT[b])) + 8));
    const R = (i) => i * COL + COL / 2;
    const tags = ["main", ...W.order].map((id) => {
      const isMain = id === "main", end = isMain ? mainEnd : headT[id], idle = !isMain && o.idle(id);
      return { id, i: rowOf[id], end, idle, t: end + (idle ? 18 : 10) + (isMain ? 6 : 0), w: tagW(id), avs: isMain ? [] : o.agentsOn(id) };
    }), tagOf = Object.fromEntries(tags.map((tg) => [tg.id, tg]));
    if (o.upright) {
      const placed = [];
      for (const g of [...tags].sort((a, b) => a.t - b.t)) {
        const hit = () => placed.find((p) => Math.abs(R(p.i) - R(g.i)) < (p.w + g.w) / 2 + 4 && Math.abs(p.t - g.t) < TAG_H + 2 + (p.avs.length ? AV : 0));
        for (let p; (p = hit()); ) g.t = p.t + TAG_H + 3 + (p.avs.length ? AV : 0);
        placed.push(g);
      }
    }
    // how far the plot reaches along time: upright, the highest tag; lying down, the longest one
    const topT = o.upright ? Math.max(nowT + 14, ...tags.map((g) => g.t + TAG_H + (g.avs.length ? AV + 2 : 0) + 4))
      : Math.max(nowT + 30, ...tags.map((g) => g.t + g.w + Math.min(3, g.avs.length) * AV + 12));

    // ---------------------------------------------------------- geometry
    // the plot is drawn in time × row; upright turns it a quarter turn
    const rowsW = nRows * COL;
    const mainC = R(rowOf.main);
    const UW = Math.max(o.width, 2 * Math.max(mainC, rowsW - mainC) + 24);
    const off = o.upright ? Math.round(UW / 2 - mainC) : 0;
    const GROUND = 14, H = o.upright ? Math.max(o.height, topT + GROUND + 8) : Math.max(o.height - 2, rowsW + 8);
    const Wd = o.upright ? UW : Math.max(o.width, topT + 12);
    const baseY = H - GROUND;
    // lying down, main sits in the middle of the panel while both sides fit around it
    const down = o.upright ? 0 : Math.max(0, Math.min(Math.round((H - 8) / 2 - mainC), H - 8 - rowsW));
    const P = (t, r) => (o.upright ? [r + off, baseY - t] : [t + 6, r + 4 + down]);
    const pt = (t, r) => P(t, r).map((v) => +v.toFixed(1)).join(" ");
    const path = (pts) => "M" + pts.map(([t, r], k) => (k === 1 && pts.length === 4 ? "C" : "") + pt(t, r)).join(" ");
    const line = (t0, t1, r) => `M${pt(t0, r)} L${pt(t1, r)}`;
    // a fork leaves its parent slanting and curves into its own row (the website's sprout), then runs along it
    const sprout = (t0, r0, t1, r1) => {
      if (r0 === r1) return line(t0, t1, r1);
      const d = bendOf(r1 - r0, t1 - t0), dr = r1 - r0;
      return path([[t0, r0], [t0 + d * 0.45, r0 + dr * 0.3], [t0 + d * 0.55, r1], [t0 + d, r1]]) + ` L${pt(t1, r1)}`;
    };
    // a merge or publish runs along its source's row, then curves into the target where it lands
    const rise = (t0, r0, t1, r1) => {
      if (r0 === r1) return line(t0, t1, r0);
      const d = bendOf(r1 - r0, t1 - t0), dr = r1 - r0;
      return `M${pt(t0, r0)} L${pt(t1 - d, r0)} C${pt(t1 - d * 0.35, r0)} ${pt(t1, r0 + dr * 0.45)} ${pt(t1, r1)}`;
    };
    const color = (b) => (b && B[b] ? `var(${B[b].color})` : "var(--trunk)");
    const spin = (deg) => (o.upright ? deg - 90 : deg);
    const lineOf = (n) => (n.branch ? rowOf[n.branch] : rowOf.main);
    const at = (id) => { const n = N[id]; return n && pos[id] !== undefined ? P(pos[id], R(lineOf(n))) : null; };
    const pop = (id) => (W.newNodes && W.newNodes.has(id) ? " popin" : "");

    let g = "";
    // the open tab's lane, banded; lying down a lane is shared, so the band runs
    // only along its Branch's bough, from its fork past its tag (main has none)
    const ai = rowOf[o.active];
    if (ai !== undefined && (o.upright || o.active !== "main")) {
      const t0 = o.upright ? 0 : baseT[o.active], t1 = o.upright ? topT : tagOf[o.active].t + tagOf[o.active].w + 6;
      const [x0, y0] = P(t1, R(ai) - COL / 2), [x1, y1] = P(t0, R(ai) + COL / 2);
      g += `<rect class="lane" x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}"/>`;
    }
    // a faint line across the plot at each Layer, and "now" above everything
    const across = (t, cls) => { const [x0, y0] = P(t, 0), [x1, y1] = P(t, rowsW); return o.upright ? `<line class="${cls}" x1="0" x2="${Wd}" y1="${y0}" y2="${y0}"/>` : `<line class="${cls}" x1="${x0}" x2="${x1}" y1="0" y2="${H}"/>`; };
    for (const n of Object.values(N)) if (n.kind === "layer") g += across(pos[n.id], "grid");
    g += across(nowT, "now");
    { const [x, y] = P(nowT, 0); g += o.upright ? `<text class="nowt" x="6" y="${y - 4}">now</text>` : `<text class="nowt" x="${x + 3}" y="11">now</text>`; }

    // forks, merges and publishes under every bough
    for (const b of W.order) {
      const r0 = R(rowOf[parentOf(b)]), r1 = R(rowOf[b]);
      g += `<path class="fork${o.idle(b) ? " bare" : ""}" style="stroke:${color(b)}" d="${sprout(baseT[b], r0, forkT[b], r1)}"/>`;
    }
    for (const n of Object.values(N)) {
      const src = n.parents[1] && N[n.parents[1]];
      if (!src || pos[src.id] === undefined) continue;
      const r0 = R(lineOf(src)), r1 = R(lineOf(n)), near = o.active !== "main" && (src.branch === o.active || n.branch === o.active);
      const data = `data-from="${esc(src.branch || "main")}" data-to="${esc(n.branch || "main")}" data-at="${esc(n.id)}"`;
      g += `<path class="${n.kind === "layer" ? "publish" : "graft"} link${near ? "" : " far"}" ${data} style="stroke:${color(src.branch)}" d="${rise(pos[src.id], r0, pos[n.id], r1)}"/>`;
    }
    // boughs end at their head; a Branch nobody is on goes on as a bare twig to its tag
    for (const b of W.order) {
      const r = R(rowOf[b]), d = depthOf[b];
      g += `<path class="bough" style="stroke:${color(b)};stroke-width:${d ? 2.6 : 3.4}" d="${line(forkT[b], headT[b], r)}"/>`;
      if (o.idle(b)) g += `<path class="twig" d="${line(headT[b], tagOf[b].t - 2, r)}"/>`;
    }
    // main: the green middle bough, with a band per Layer
    const solid = Math.min(mainEnd, mainHead + 6);
    g += `<path class="trunk" style="stroke-width:${MAIN_TH}" d="${line(0, solid, mainC)}"/>`;
    if (mainEnd > solid + 2) g += `<path class="trunk-on" d="${line(solid + 4, mainEnd, mainC)}"/>`;
    for (const n of Object.values(N)) if (n.kind === "layer") {
      const [x, y] = P(pos[n.id], mainC), src = n.parents[1] && N[n.parents[1]], c = src ? color(src.branch) : "var(--green-dark)";
      const [w, h] = o.upright ? [MAIN_TH + 8, 5] : [5, MAIN_TH + 8], sel = o.selected === n.id ? " sel" : "";
      g += `<g class="node layer${pop(n.id)}${sel}" data-node="${esc(n.id)}"><rect class="hit" x="${x - 12}" y="${y - 9}" width="24" height="18"/><rect class="band" style="fill:${c}" x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="1.5"/></g>`;
      g += o.upright ? `<text class="lid" style="fill:${c}" x="${x - MAIN_TH - 8}" y="${y + 3.5}" text-anchor="end">${esc(n.id)}</text>`
        : `<text class="lid" style="fill:${c}" x="${x + 4}" y="${y - MAIN_TH - 5}">${esc(n.id)}</text>`;
    }
    // fork points: a small knot where the Branch begins
    for (const b of W.order) {
      const id = "fork:" + b, [x, y] = P(forkT[b], R(rowOf[b]));
      g += `<g class="node knot${pop(id)}${o.selected === id ? " sel" : ""}" data-node="${esc(id)}"><circle class="hit" cx="${x}" cy="${y}" r="7"/><circle cx="${x}" cy="${y}" r="3" style="stroke:${color(b)}"/></g>`;
    }
    // Commits are leaves, turning up and down along the bough in shades of its
    // colour; a merge is a ring in the Branch's colour with the source's at its heart
    const shades = ["", "color-mix(in srgb, %c 70%, white)", "color-mix(in srgb, %c 82%, black)"];
    const commits = Object.values(N).filter((n) => n.kind === "commit").sort((x, y) => pos[x.id] - pos[y.id]);
    const flip = {};
    for (const n of commits) {
      const [x, y] = P(pos[n.id], R(rowOf[n.branch])), c = color(n.branch), sel = o.selected === n.id ? " sel" : "";
      const k = (flip[n.branch] = (flip[n.branch] || 0) + 1);
      if (n.parents[1]) {
        g += `<g class="node merge${pop(n.id)}${sel}" data-node="${esc(n.id)}"><circle class="ring" cx="${x}" cy="${y}" r="6.5" style="stroke:${c}"/><circle cx="${x}" cy="${y}" r="2.8" style="fill:${color(N[n.parents[1]] && N[n.parents[1]].branch)}"/></g>`;
        continue;
      }
      const fill = (shades[Number(n.id.replace(/\D/g, "")) % 3] || "%c").replaceAll("%c", c);
      g += `<g class="node leaf${pop(n.id)}${sel}" data-node="${esc(n.id)}"><circle class="hit" cx="${x}" cy="${y}" r="9"/><g transform="translate(${x} ${y}) rotate(${spin(k % 2 ? -38 : 38)})"><path d="${LEAF}" style="fill:${fill}"/><path class="vein" d="M1.5 0H12"/></g></g>`;
    }
    // mounted Workspaces: a badge on the node they are based on (red when stale)
    const mounted = {};
    for (const w of Object.values(W.ws)) (mounted[w.baseNode] ||= []).push(w);
    for (const [id, ws] of Object.entries(mounted)) {
      const p = at(id), n = N[id];
      if (!p) continue;
      const stale = n.branch && B[n.branch] && id !== B[n.branch].head;
      g += `<g class="mbadge${stale ? " stale" : ""}"><circle cx="${p[0] + 9}" cy="${p[1] - 9}" r="6.5"/><text x="${p[0] + 9}" y="${p[1] - 6}" text-anchor="middle">${ws.length}</text></g>`;
    }
    // name tags, and the agents on each Branch standing on its tag
    for (const tg of tags) {
      const isMain = tg.id === "main", r = R(tg.i), c = isMain ? "var(--green-dark)" : color(tg.id), [hx, hy] = P(tg.end, r);
      let x, y;
      if (o.upright) { [x, y] = P(tg.t, r); x -= tg.w / 2; y -= TAG_H; } else { [x, y] = P(tg.t, r); y -= TAG_H / 2; }
      if (o.upright && tg.t - tg.end > (tg.idle ? 22 : 14)) g += `<path class="leader" d="M${hx} ${hy - 4} L${hx} ${y + TAG_H}"/>`;
      g += `<g class="tag${tg.idle ? " idle" : ""}${tg.id === o.active ? " on" : ""}" data-open="${esc(tg.id)}" style="--tc:${c}"><title>${isMain ? "main · read-only · open the main tab" : `Open ${esc(tg.id)} · forked from ${esc(B[tg.id].base)}`}</title>`
        + `<rect x="${x}" y="${y}" width="${tg.w}" height="${TAG_H}" rx="2"/><text x="${x + 4}" y="${y + 10.5}">${esc(tg.id)}</text></g>`;
      tg.avs.slice(0, 3).forEach((n, k) => {
        const ax = o.upright ? x + tg.w / 2 - (Math.min(3, tg.avs.length) * AV) / 2 + k * AV : x + tg.w + 4 + k * AV, ay = o.upright ? y - AV - 1 : y - 1;
        g += `<g class="tav" transform="translate(${ax} ${ay})">${o.head(n)}</g>`;
      });
    }
    if (o.upright) g += `<rect class="ground" x="0" y="${baseY}" width="${Wd}" height="${GROUND}"/><line class="groundline" x1="0" x2="${Wd}" y1="${baseY + 0.5}" y2="${baseY + 0.5}"/>`;
    const svg = `<svg class="graph tree${o.upright ? " upright" : " sideways"}" width="${Wd}" height="${H}" viewBox="0 0 ${Wd} ${H}" data-dir="${o.upright ? "up" : "side"}" data-span="${topT}" data-base="${baseY}">${g}</svg>`;

    // ---------------------------------------------------------- overview
    // the whole run in one strip: Commits counted over time, Layers as green
    // ticks; the view moves its box as the tree scrolls
    const OW = 300, nb = 60, bins = new Array(nb).fill(0);
    for (const n of commits) bins[Math.min(nb - 1, Math.floor((pos[n.id] / topT) * nb))]++;
    const peak = Math.max(3, ...bins), bw = OW / nb;
    let ov = bins.map((v, i) => (v ? `<rect class="bar" x="${(i * bw + 0.5).toFixed(1)}" y="${(30 - (v / peak) * 22).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${((v / peak) * 22).toFixed(1)}"/>` : "")).join("");
    for (const n of Object.values(N)) if (n.kind === "layer") ov += `<rect class="tick" x="${((pos[n.id] / topT) * OW - 1).toFixed(1)}" y="2" width="2" height="6"/>`;
    ov += `<line class="nowl" x1="${((nowT / topT) * OW).toFixed(1)}" x2="${((nowT / topT) * OW).toFixed(1)}" y1="0" y2="34"/>`;
    const overview = `<svg class="ovs" viewBox="0 0 ${OW} 34" preserveAspectRatio="none">${ov}</svg>`;
    return { svg, overview };
  };
}
