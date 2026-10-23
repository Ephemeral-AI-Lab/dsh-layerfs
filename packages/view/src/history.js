// The History panel, as the dsh chat draws it, shared by the chat's LayerFS
// tab and the project board: a header (History or Files of the open tab, the
// tab's ref, its Commit count, Play, the tree's orientation), then the project's
// tree (tree.js) with its zoom, Overview strip and a "?" legend, or Files
// (files.js). Hovering a node opens its card. The panel draws as a string
// (html), then is placed in its box (place); its host routes clicks, hovers
// and scrolls to it.
import * as X from "../../model/src/index.js";
import { createTree, LEAF } from "./tree.js";
import { createTreeZoom } from "./treezoom.js";
import { esc } from "./util.js";

const LEGEND = `<div class="tlegend" role="note" aria-label="Legend">
  <span><svg width="22" height="12" viewBox="0 0 22 12"><rect y="3" width="22" height="6" rx="3" style="fill:var(--trunk)"/><rect x="9" y="0.5" width="4" height="11" rx="1.5" style="fill:var(--b0);stroke:#fff"/></svg>Layer · a band on main</span>
  <span><svg width="26" height="12" viewBox="0 0 26 12"><path d="${LEAF}" transform="translate(1 6) rotate(-20)" style="fill:var(--b0)"/><path d="${LEAF}" transform="translate(12 6) rotate(20)" style="fill:var(--b1)"/></svg>Commit · a leaf</span>
  <span><svg width="20" height="12" viewBox="0 0 20 12"><path d="M2 1C2 9 5 10 19 10" fill="none" style="stroke:var(--b2)" stroke-width="2.6" stroke-linecap="round"/></svg>Branch · a bough</span>
  <span><svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.2" fill="#fff" style="stroke:var(--b3)" stroke-width="2.2"/><circle cx="7" cy="7" r="2.2" style="fill:var(--b0)"/></svg>merge · grafts back</span>
  <span><i class="dash"></i>publish · adds a band</span>
  <span><svg width="20" height="12" viewBox="0 0 20 12"><path d="M1 6H16" style="stroke:var(--twig)" stroke-width="2.4" stroke-linecap="round"/></svg>idle · bare twig</span>
  <span class="hint">click a node: Files there · a name tag: its tab</span></div>`;

/**
 * @param {object} o
 * @param {HTMLElement} o.root the view's root (the card and zoom live in it)
 * @param {object} o.v the view's state: W, active tab, rightMode, orient, project
 * @param {object} o.files the Files component (files.js) for the same state
 * @param {(n: string) => object} o.avatar an agent's hero
 * @param {(n: string) => string} o.mascot an agent's small hero
 * @param {(n: string) => string} o.head an agent's head for the tree's name tags (SVG)
 * @param {(lane: string, id: string, mode: string) => void} o.openAt a card's Browse/Diff: Files at a node
 * @param {(by: string, id: string, node: object) => void} [o.visit] a node the replay grew: its maker shows up on it
 */
export function createHistory(o) {
  const { root, v, files, avatar, mascot } = o;
  const q = (sel) => root.querySelector(sel);
  const card = document.createElement("div");
  card.className = "hcard"; card.setAttribute("role", "tooltip");
  root.append(card);
  const tree = createTree();
  // the tree shows "now" (upright: the top, centred on main; lying down: the
  // right end) until the viewer scrolls, zooms or pans it; then it keeps their place
  let auto = true, set = null, drawnFor = null, cardTimer = null;
  let legend = false; // the legend opens over the tree from its "?" button
  const tz = createTreeZoom({ root, onZoom: () => { auto = false; placeOverview(); } });

  /** A Branch nobody is on, whose tab has faded: a bare twig in the tree. */
  // When a Branch fades to a bare twig and frees its lane, the same in Play and
  // live: FADE_STEPS events after its last one (its own nodes, and merges or
  // publishes out of it). Live, a Branch someone is on, with a Workspace
  // mounted or in conflict, stays in leaf.
  const FADE_STEPS = 6;
  function eventsOf(W) {
    const slots = [...new Set(Object.values(W.nodes).map((n) => n.t))].sort((a, b) => a - b), last = {};
    for (const n of Object.values(W.nodes)) {
      if (n.branch) last[n.branch] = Math.max(last[n.branch] ?? -Infinity, n.t);
      const src = n.parents[1] && W.nodes[n.parents[1]];
      if (src && src.branch) last[src.branch] = Math.max(last[src.branch] ?? -Infinity, n.t);
    }
    return { slots, last, rank: new Map(slots.map((t, k) => [t, k])) };
  }
  /** Is Branch b done at slot index i: its last event more than FADE_STEPS events back. */
  const doneAt = (ev, i) => (b) => ev.last[b] !== undefined && i - ev.rank.get(ev.last[b]) > FADE_STEPS;
  function branchIdle(b) {
    const W = v.W;
    return !X.agentsOn(W, b).length && !X.mounted(W, b) && !X.conflicted(W, b) && W.clock - W.branches[b].last > X.FADE_S;
  }
  /** The node a tab's Files is fixed at, or null while it follows the head. */
  function pinnedAt(tab) { const at = files.filesOf(tab).at; return at === "latest" ? null : at; }
  // The tree keeps each Branch's lane from when it first drew it. Opened on a
  // run already under way, it first grows through the run's forks the way Play
  // does, so its lanes are the ones Play shows (and those growing live had).
  let grown = false;
  const treeOf = (tab, size) => {
    const W = v.W, ev = eventsOf(W), done = doneAt(ev, ev.slots.length - 1);
    const base = { upright: v.orient === "upright", width: size.w, height: size.h, active: tab, selected: null, agentsOn: () => [], head: o.head };
    if (!grown && W.order.length > 1) {
      for (const t of [...new Set(W.order.map((b) => W.nodes["fork:" + b] && W.nodes["fork:" + b].t))].filter((t) => t !== undefined).sort((x, y) => x - y)) {
        const d = doneAt(ev, ev.rank.get(t));
        tree(cutAt(W, t), { ...base, idle: d, stopped: d });
      }
    }
    if (W.order.length) grown = true;
    const faded = (b) => done(b) && (v.project || (!X.agentsOn(W, b).length && !X.mounted(W, b) && !X.conflicted(W, b)));
    return tree(W, { ...base, selected: pinnedAt(tab), agentsOn: (b) => (v.project ? [] : X.agentsOn(W, b)), idle: faded, stopped: faded });
  };
  /** The tree's box: the drawn one, else the panel's less its header, Overview and legend. */
  function size(host) {
    const el = q("[data-tree]");
    if (el) return { w: el.clientWidth - 2, h: el.clientHeight - 2 };
    return { w: Math.max(240, (host ? host.clientWidth : 440) - 2), h: Math.max(240, (host ? host.clientHeight : 640) - 170) };
  }

  // ---------------------------------------------------------------- replay
  // Play replays History like a film: the tree is drawn from the model cut at
  // each step, from the first event to now, and grows and zooms out as it did
  // live. A Branch whose last event has passed turns to a bare twig. Pause
  // holds the frame; the end, "now" or another tab's view goes back to live.
  // about STEP_MS an event, so a short History plays briskly and a long one
  // fits in PLAY_MS (never under PLAY_MIN)
  const PLAY_MS = 14000, PLAY_MIN = 3000, STEP_MS = 300, TICK_MIN = 30;
  let play = null;
  /** The model as it stood at slot `t`: its nodes up to then, each Branch's head then. */
  function cutAt(W, t) {
    const nodes = {};
    for (const [id, n] of Object.entries(W.nodes)) if (n.t <= t) nodes[id] = n;
    const order = W.order.filter((b) => nodes["fork:" + b]), branches = {};
    for (const b of order) {
      let head = nodes[W.branches[b].head] ? W.branches[b].head : "fork:" + b, ht = -Infinity;
      if (head === "fork:" + b) for (const n of Object.values(nodes)) if (n.kind === "commit" && n.branch === b && n.t > ht) { ht = n.t; head = n.id; }
      branches[b] = { ...W.branches[b], head };
    }
    let mainHead = null, mt = -Infinity;
    for (const n of Object.values(nodes)) if (n.kind === "layer" && n.t > mt) { mt = n.t; mainHead = n.id; }
    return { ...W, nodes, order, branches, mainHead, ws: {}, newNodes: new Set() };
  }
  function startPlay() {
    const ev = eventsOf(v.W), slots = ev.slots;
    if (slots.length < 2) return;
    const total = Math.min(PLAY_MS, Math.max(PLAY_MIN, slots.length * STEP_MS));
    const tick = Math.max(TICK_MIN, total / slots.length);
    play = { slots, ev, i: 0, tick, per: Math.max(1, Math.round((slots.length * tick) / total)), tree: createTree(), timer: null, paused: false, shown: new Set(), greeted: 0 };
    frame();
  }
  function stopPlay() { if (play) clearTimeout(play.timer); play = null; }
  function frame() {
    const panel = q("[data-tree]") && q("[data-tree]").closest(".hist");
    if (!play || !panel) { stopPlay(); auto = true; v.render(); return; }
    const sz = size();
    const next = document.createElement("div");
    next.innerHTML = html(sz);
    patch(panel, next, 4);
    place(null, sz);
    if (o.visit) greet();
    if (play.paused) return;
    if (play.i >= play.slots.length - 1) { play.timer = setTimeout(() => { stopPlay(); auto = true; v.render(); }, 900); return; }
    play.timer = setTimeout(() => { if (!play) return; play.i = Math.min(play.slots.length - 1, play.i + play.per); frame(); }, play.tick);
  }
  // A frame keeps every element that did not change, so a button pressed
  // between frames is still the one released (else the click is lost): only
  // what differs is replaced, down to a few levels, then whole.
  function patch(el, next, depth) {
    const a = [...el.childNodes], b = [...next.childNodes];
    if (a.length !== b.length) { el.replaceChildren(...b); return; }
    a.forEach((old, i) => {
      const nu = b[i];
      if (old.isEqualNode(nu)) return;
      const same = depth > 0 && old.nodeType === 1 && nu.nodeType === 1 && old.tagName === nu.tagName
        && old.attributes.length === nu.attributes.length && [...nu.attributes].every((x) => old.getAttribute(x.name) === x.value);
      if (same) patch(old, nu, depth - 1);
      else old.replaceWith(nu);
    });
  }
  // the nodes this frame grew get their makers' visits (o.visit): the newest
  // few, and no more often than a visit can be seen on a fast replay
  function greet() {
    const now = Object.values(play.cut.nodes), fresh = now.filter((n) => !play.shown.has(n.id)).sort((a, b) => b.t - a.t);
    for (const n of now) play.shown.add(n.id);
    if (Date.now() - play.greeted < 200) return;
    play.greeted = Date.now();
    for (const n of fresh.filter((n) => n.by).slice(0, play.tick >= 200 ? 3 : 1)) o.visit(n.by, n.id, n);
  }
  /** The tree as the replay has it now, or null when History is live. */
  function playTree(tab, sz) {
    const t = play.slots[play.i], W = play.cut = cutAt(v.W, t);
    // a Branch fades a few steps after its last event, as the live tree does
    const done = doneAt(play.ev, play.i);
    return { W, t: play.tree(W, { upright: v.orient === "upright", width: sz.w, height: sz.h, active: tab, selected: null, agentsOn: () => [], head: o.head, idle: done, stopped: done }) };
  }

  function html(sz) {
    const tab = v.active, mode = v.rightMode[tab] || "history";
    if (play && mode !== "history") stopPlay();
    const cut = play && playTree(tab, sz), W = cut ? cut.W : v.W, B = W.branches[tab], color = (v.W.branches[tab] || {}).color;
    const headId = tab === "main" ? W.mainHead : !B ? null : B.head.startsWith("fork:") ? B.base : B.head;
    const nC = Object.values(W.nodes).filter((n) => n.kind === "commit").length;
    // the File, History and Storage tabs around it switch views (view.js drawIde)
    const seg = "";
    const orient = mode !== "history" ? "" : `<span class="seg" role="group" aria-label="History view">${[["upright", "Upright", "M6 11V1M6 6L2.5 3M6 8L9.5 5"], ["sideways", "Sideways", "M1 6H11M6 6L3 2.5M8 6L5 9.5"]]
      .map(([k, l, d]) => `<button class="${v.orient === k ? "on" : ""}" data-orient="${k}" aria-pressed="${v.orient === k}" title="${l}" aria-label="${l}"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="${d}"/></svg></button>`).join("")}</span>`;
    const playing = play && !play.paused;
    const playBtn = mode !== "history" ? "" : `<span class="seg"><button class="${play ? "on" : ""}" data-play="1" aria-pressed="${!!playing}" title="${playing ? "Pause the replay" : play ? "Go on with the replay" : "Replay History from the start"}">`
      + `<svg viewBox="0 0 12 12" aria-hidden="true"><path class="fill" d="${playing ? "M3 2H5V10H3ZM7 2H9V10H7Z" : "M3 1.5L10 6L3 10.5Z"}"/></svg><span class="lbl">${playing ? "Pause" : "Play"}</span></button></span>`;
    const head = `<div class="phead">${seg}<span class="ref" style="color:${tab === "main" ? "var(--green-dark)" : `var(${color})`}">${esc(tab)} @ ${esc(headId || "–")}</span><span class="m">${nC} commit${nC === 1 ? "" : "s"}${play ? " · replay" : ""}</span><span class="sp"></span>${playBtn}${orient}</div>`;
    if (!W.mainHead && !play) return head + `<div class="empty">No project yet</div>`;
    const t = cut ? cut.t : treeOf(tab, sz);
    const key = `<button class="tkey${legend ? " on" : ""}" data-legend="1" aria-expanded="${legend}" title="${legend ? "Hide the legend" : "What the tree's marks mean"}" aria-label="Legend">?</button>${legend ? LEGEND : ""}`;
    return head + `<div class="treebox">${tz.controlsHtml()}${key}<div class="treewrap" data-tree tabindex="0" aria-label="History tree: drag to pan, ⌘ + scroll to zoom">${t.svg}</div></div>`
      + `<div class="ov"><div class="ovl"><span>Overview</span><button data-now="1" title="Back to now">now</button></div><div class="ovstrip" data-ov title="Click to move there">${t.overview}<i class="ovbox"></i></div></div>`;
  }

  /** Where the viewer has the tree now, to keep across a redraw. */
  function keep() { const el = q("[data-tree]"); return el && { left: el.scrollLeft, top: el.scrollTop }; }
  /** After a redraw: the zoom, the tree's place, and whether its box came out another size than `sz` (draw again). */
  function place(at, sz) {
    tz.apply();
    const el = q("[data-tree]");
    if (el) {
      if (auto || !at) {
        if (v.orient === "upright") { el.scrollTop = 0; el.scrollLeft = Math.max(0, Math.round((el.scrollWidth - el.clientWidth) / 2)); }
        else el.scrollLeft = el.scrollWidth;
      } else { el.scrollLeft = at.left; el.scrollTop = at.top; }
      set = { left: el.scrollLeft, top: el.scrollTop };
      placeOverview();
    }
    drawnFor = el && { w: el.clientWidth, h: el.clientHeight };
    light(litAt); // the redraw dropped the hovered Branch's lines
    // a node card whose node went away with the redraw (History became Files) never saw its mouseout
    if (card.classList.contains("open") && !card.matches(":hover") && !root.querySelector("svg.graph [data-node]:hover")) hideCard(true);
    return !!(el && sz && (Math.abs(el.clientWidth - 2 - sz.w) > 8 || Math.abs(el.clientHeight - 2 - sz.h) > 8));
  }
  /** The tree's box changed size since it was drawn: it needs drawing again. */
  function resized() {
    const el = q("[data-tree]");
    return !!(el && drawnFor && (Math.abs(el.clientWidth - drawnFor.w) > 8 || Math.abs(el.clientHeight - drawnFor.h) > 8));
  }
  // the Overview's box: the part of the run the tree shows
  function placeOverview() {
    const el = q("[data-tree]"), box = q(".ovbox"), svg = el && el.querySelector("svg");
    if (!box || !svg) return;
    const z = tz.zoom, span = +svg.dataset.span * z, base = +svg.dataset.base * z;
    const [a, b] = svg.dataset.dir === "up" ? [base - el.scrollTop - el.clientHeight, base - el.scrollTop] : [el.scrollLeft - 6 * z, el.scrollLeft + el.clientWidth - 6 * z];
    const lo = Math.max(0, a / span), hi = Math.min(1, b / span);
    box.style.left = (lo * 100).toFixed(2) + "%"; box.style.width = Math.max(2, (hi - lo) * 100).toFixed(2) + "%";
  }
  function overviewTo(e, strip) {
    const el = q("[data-tree]"), svg = el && el.querySelector("svg");
    if (!svg) return;
    const z = tz.zoom, r = strip.getBoundingClientRect(), t = ((e.clientX - r.left) / r.width) * +svg.dataset.span * z;
    if (svg.dataset.dir === "up") el.scrollTop = +svg.dataset.base * z - t - el.clientHeight / 2;
    else el.scrollLeft = t + 6 * z - el.clientWidth / 2;
    auto = false;
  }

  // ---------------------------------------------------------------- node card
  // What a History node is, who made it, and which Workspaces are mounted on it.
  function wsRows(name, nodeId) {
    const W = v.W, s = W.engine.s, head = s.branches[name].head || "fork:" + name, rows = [];
    for (const id of s.sandboxOrder) for (const p of s.sandboxes[id].wsOrder) {
      const w = s.sandboxes[id].workspaces[p];
      if (!w.mounted || w.branch !== name || (w.baseCommit || "fork:" + name) !== nodeId) continue;
      const k = `${id}:${p}`, dirty = W.engine.dirtyOf(w), stale = nodeId !== head, agent = (W.panes[k] || {}).agent;
      rows.push(`<button class="ws${stale ? " stale" : ""}" data-open="${esc(name)}" title="Open the ${esc(name)} tab"><span class="d"></span>${agent ? mascot(agent) : ""}${esc(k)}${dirty ? ` · +${dirty}` : ""}<small>${stale ? `stale · head ${head.replace("fork:", "")}` : "current"}</small></button>`);
    }
    return rows.length ? `<div class="sec">Workspaces mounted here</div>${rows.join("")}` : "";
  }
  function cardHtml(id) {
    const W = v.W, s = W.engine.s, who = W.attrib[id], by = who ? `by <b style="color:${avatar(who).color}">${esc(who)}</b>` : "", head = '<span class="tag">head</span>';
    const btns = `<div class="cbtns"><button class="cbtn" data-card-at="${esc(id)}">Browse files</button></div><div class="hint">Click the node: the sidebar's files show this point</div>`;
    if (s.layers[id]) {
      const l = s.layers[id];
      return `<div class="h"><b>${l.id}</b>main${id === s.main.head ? head : ""}</div><div class="meta">Layer${l.root ? ` · root ${l.root}` : ""}<br>${l.sourceCommit ? `published from ${esc(l.sourceBranch)} ${l.sourceCommit}` : "project.init"}${by ? "<br>" + by : ""}</div>${btns}`;
    }
    if (s.commits[id]) {
      const c = s.commits[id];
      const lww = (list) => (list && list.length ? "<br>" + list.map((d) => `last-writer-wins ${esc(d.path)} ← ${esc(d.kept)}`).join("<br>") : "");
      const owner = (n) => (s.commits[n] ? `${esc(s.commits[n].branch)} ${n}` : `main ${n}`);
      const mrg = c.mergedFrom ? `<div class="sec">Merge</div><div class="meta">merged from ${owner(c.mergedFrom)} into ${c.parent ? owner(c.parent) : "main " + c.base}${c.mergeBase ? `<br>merge base ${esc(c.mergeBase)}` : ""}${lww(c.lww)}</div>`
        : c.merged ? `<div class="sec">Merged on commit</div><div class="meta">the Workspace was on ${c.merged.from}; merged with head ${c.merged.head}${lww(c.merged.lww)}</div>` : "";
      const after = c.displacedBy ? `<div class="sec">Off the line</div><div class="meta">${c.displacedBy} was committed with --force, so ${c.id} is no longer an ancestor of the head.</div>` : "";
      const b = s.branches[c.branch];
      return `<div class="h"><b>${c.id}</b>${esc(c.branch)}${b && b.head === id ? head : ""}</div>
        <div class="meta">parent ${c.parent || "Branch base"}${c.root ? ` · root ${c.root}` : ""}<br>${by}${by ? " · " : ""}${esc(c.message || c.via)}<br>via ${esc(c.by === "fs" ? c.via : c.by === "merge" ? "branch.merge" : "sandbox.commit " + c.via)}</div>${mrg}${after}${wsRows(c.branch, id)}${btns}`;
    }
    const name = id.slice(5), b = s.branches[name];
    return `<div class="h"><b>${esc(name)}</b>fork point${b.head ? "" : head}</div><div class="meta">forked from ${b.from}${b.head ? "" : " · no Commits yet"}${by ? "<br>" + by : ""}</div>${wsRows(name, id)}${btns}`;
  }
  function showCard(node) {
    clearTimeout(cardTimer);
    const r = node.getBoundingClientRect(), base = root.getBoundingClientRect();
    card.innerHTML = cardHtml(node.dataset.node);
    card.classList.add("open");
    const h = card.offsetHeight, w = root.clientWidth, top = r.bottom - base.top + 8;
    card.style.left = Math.max(8, Math.min(w - 298, r.left - base.left + r.width / 2 - 145)) + "px";
    card.style.top = (top + h > root.clientHeight ? r.top - base.top - h - 8 : top) + "px";
  }
  const hideCard = (now) => { clearTimeout(cardTimer); cardTimer = setTimeout(() => card.classList.remove("open"), now ? 0 : 180); };
  const onCardEnter = () => clearTimeout(cardTimer), onCardLeave = () => hideCard();
  card.addEventListener("mouseenter", onCardEnter);
  card.addEventListener("mouseleave", onCardLeave);

  // ---------------------------------------------------------------- events
  /** A click inside the panel or its card; true when it was the panel's. */
  function click(e) {
    if (tz.click(e)) return true;
    const at = (sel) => e.target.closest(sel);
    let el;
    if ((el = at("[data-card-at], [data-card-cmp]"))) {
      const id = el.dataset.cardAt || el.dataset.cardCmp, n = v.W.nodes[id];
      if (n) { hideCard(true); o.openAt(n.branch || "main", id, el.dataset.cardCmp ? "diff" : "view"); }
      return true;
    }
    if ((el = at("[data-orient]"))) { v.orient = el.dataset.orient; auto = true; v.render(); return true; }
    if (at("[data-play]")) {
      if (!play) startPlay();
      else if ((play.paused = !play.paused)) { clearTimeout(play.timer); v.render(); }
      else frame();
      return true;
    }
    if (at("[data-legend]")) { legend = !legend; v.render(); return true; }
    if (at("[data-now]")) { stopPlay(); auto = true; v.render(); return true; }
    if ((el = at("[data-ov]"))) { overviewTo(e, el); return true; }
    return false;
  }
  // under the pointer, a Branch's tag or node lights its merges and publishes (and a node the ones into it)
  const hovered = (el) => {
    const n = el && el.closest && el.closest("svg.tree [data-node], svg.tree [data-open]");
    if (!n) return null;
    const node = n.dataset.node && v.W.nodes[n.dataset.node];
    return { b: n.dataset.open || (node && node.branch) || null, id: n.dataset.node || null };
  };
  let litAt = null;
  function light(at) {
    litAt = at;
    const svg = q("svg.tree");
    if (!svg) return;
    for (const p of svg.querySelectorAll(".link.on")) p.classList.remove("on");
    if (!at) return;
    const sel = [at.b && `.link[data-from="${CSS.escape(at.b)}"], .link[data-to="${CSS.escape(at.b)}"]`, at.id && `.link[data-at="${CSS.escape(at.id)}"]`].filter(Boolean).join(", ");
    for (const p of svg.querySelectorAll(sel)) p.classList.add("on");
  }
  const over = (e) => { const n = e.target.closest && e.target.closest("svg.graph [data-node]"); if (n) showCard(n); light(hovered(e.target)); };
  const out = (e) => { const n = e.target.closest && e.target.closest("svg.graph [data-node]"); if (n && !n.contains(e.relatedTarget)) hideCard(); light(hovered(e.relatedTarget)); };
  // the viewer scrolling the tree takes it off "now"; the Overview's box follows
  const scroll = (e) => {
    const el = e.target;
    if (!el.matches || !el.matches("[data-tree]")) return;
    if (set && (Math.abs(el.scrollLeft - set.left) > 2 || Math.abs(el.scrollTop - set.top) > 2)) auto = false;
    placeOverview();
  };

  return {
    html, size, keep, place, resized, click, over, out, scroll, pinnedAt, branchIdle,
    /** Back to "now" on the next draw (the panel moved or changed size). */
    toNow() { auto = true; },
    /** Ends a replay, playing or paused, and goes back to "now" (History was left). */
    stop() { if (play) { stopPlay(); auto = true; } },
    dispose() {
      stopPlay();
      tz.dispose();
      clearTimeout(cardTimer);
      card.removeEventListener("mouseenter", onCardEnter);
      card.removeEventListener("mouseleave", onCardLeave);
      card.remove();
    },
  };
}
