// The LayerFS view, framework-free: it draws a model view (W, built by
// @dsh-layerfs/model) into one root element: the dsh client plugin's LayerFS
// tab and its LayerFS page.
//   hist     History (the project's tree) or Files of the open tab, on the left (history.js)
//   tabs     main, then one chip per active Branch, over the right panel
//   work     the main view (Branches, Sandboxes, Store, PROJECT terminal) or a
//            Branch view (FS terminal, Workspace panes)
//   overlay  avatars, bubbles and flying blocks, placed relative to the root
// With `project`, it draws one project instead, like an editor: Files' tree
// at the picked point in a sidebar, and File, History and Storage as tabs
// over the rest, on main, without terminals or avatars. A node picked in
// History sets the point; Storage is the main tab's storage panel, from the
// figures the host gives (engine.storage).
// The host owns the clock: it sets W, then calls render(), and animate() for
// the call that just happened.
import * as X from "../../model/src/index.js";
import { createFiles } from "./files.js";
import { figureStyle, headSvg, moodOf, nodeMood } from "./cast.js";
import { maidBubble, maidBurst } from "./skins/maids/voice.js";
import { createHistory } from "./history.js";
import { cmdTime, esc, fmtBytes, timingText } from "./util.js";

const { CAP, RECENT_S, bubbleOf } = X;
const html = (s) => { const t = document.createElement("template"); t.innerHTML = s.trim(); return t.content.firstElementChild; };

/**
 * @param {HTMLElement} root the view's root; it gets class `lfs`
 * @param {object} o
 * @param {object} o.avatars the cast: heroAvatars(urlOf) from skins/heroes/cast.js
 * @param {{ id: string, label: string, avatars: object }[]} [o.casts] the cast to draw
 *   with, first; its id is the root's data-skin (skins/)
 * @param {object} o.files the files helpers (simulation_engine/files.js)
 * @param {Function} o.lineDiff line diff (simulation_engine/model.js)
 * @param {boolean} [o.live] the engine reports file history itself (engine.fileReport)
 * @param {string} [o.lead] the lead agent (ellen_joe)
 * @param {object} [o.layout] existing { tabs, work, follow } elements
 * @param {"work"|"history"} [o.pane] draw only this pane: the host shows Work and History as its own tabs
 *   (the preview's); missing ones are created as the standalone layout. Without
 *   a `hist` element, History is drawn as the work area's first column
 * @param {(follow: boolean) => void} [o.onFollow] the follow toggle changed
 * @param {boolean} [o.project] draw a project: Files' tree, then File, History and Storage tabs
 */
// the LayerFS mark (the website's logo): the layer roof over three linked nodes
const LOGO = `<svg width="20" height="20" viewBox="14 8 172 172" aria-hidden="true"><path d="M88.5 22 L111.5 22 L170 135 L148.5 135 L100 49.5 L51.5 135 L30 135 Z" fill="#93B1E0" stroke="#93B1E0" stroke-width="2" stroke-linejoin="round"/><path d="M27 161 L57 161 L100 117 L143 161 L173 161" fill="none" stroke="#2F5BB5" stroke-width="10.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="100" cy="117" r="15.5" fill="#2F5BB5"/><circle cx="27" cy="161" r="15.5" fill="#2F5BB5"/><circle cx="173" cy="161" r="15.5" fill="#2F5BB5"/></svg>`;

// a project's tab icons: a file, History's branching line, the Store
const TABICON = (d) => `<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const FILEICON = TABICON("M3.5 1.5h4.5l2.5 2.5v8.5h-7z M8 1.5V4h2.5");
const HISTICON = TABICON("M4 2v10 M4 7c0-2 6-1 6-4 M10 3a1 1 0 1 0 0-.01 M4 12.5a1 1 0 1 0 0-.01");
const SIDEICON = TABICON("M1.5 2.5h11v9h-11z M5 2.5v9");
const DBICON = TABICON("M2.5 3.5c0-1.1 2-2 4.5-2s4.5.9 4.5 2-2 2-4.5 2-4.5-.9-4.5-2z M2.5 3.5v7c0 1.1 2 2 4.5 2s4.5-.9 4.5-2v-7 M2.5 7c0 1.1 2 2 4.5 2s4.5-.9 4.5-2");
const BOXICON = TABICON("M2 4.5l5-2.5 5 2.5v5l-5 2.5-5-2.5z M2 4.5l5 2.5 5-2.5 M7 7v5");

export function createView(root, o) {
  const FM = o.files, LEAD = o.lead || "main";
  let AV = o.casts ? o.casts[0].avatars : o.avatars;
  root.classList.add("lfs");
  const PROJECT = !!o.project;
  let layout = o.layout;
  if (PROJECT) {
    root.classList.add("lfs-project");
    root.innerHTML = "";
    layout = {};
  } else if (!layout) {
    root.classList.add("lfs-app");
    // one row over both views: the LayerFS mark, the Work | History switch, the tabs, Follow
    root.innerHTML = `<div class="lfs-strip"><span class="lfs-logo" role="img" aria-label="LayerFS" title="LayerFS">${LOGO}</span><div class="lfs-swap" role="tablist" aria-label="Work or History"></div><div class="tabs" role="tablist" aria-label="LayerFS tabs"></div><div class="ctl" role="group" aria-label="Follow"><button class="on" data-follow="1" aria-pressed="true" title="Follow the acting agent across tabs">Follow</button></div></div><div class="lfs-cols"><section class="panel hist" aria-label="History"></section><div class="panel right"><main class="work"></main></div></div>`;
    layout = { hist: root.querySelector(".hist"), cols: root.querySelector(".lfs-cols"), strip: root.querySelector(".lfs-strip"), swap: root.querySelector(".lfs-swap"), tabs: root.querySelector(".tabs"), work: root.querySelector(".work"), follow: root.querySelector("[data-follow]") };
  }
  const overlay = html(`<div class="lfs-fx" aria-hidden="true"></div>`);
  root.append(overlay);

  // ---------------------------------------------------------------- cast
  // The website's heroes (skins/heroes), or another cast the viewer picked
  // (cast.js). The lead is the cast's main (the cloud). Every other agent
  // gets a hero picked from a hash of its name, so it is the same on every
  // rewind, reload and backend; no hero repeats until all are in use (then a
  // number tells them apart). An agent's colour (tags, History, cards) is its hero's.
  const AGENTS = {}, AV_TAKEN = new Map(), MOOD = {};
  let VARIANTS = Object.keys(AV.heroes).filter((c) => c !== AV.main);
  /** Draws every agent with another cast: each is picked again from it. */
  function useCast(avatars) {
    AV = avatars; VARIANTS = Object.keys(AV.heroes).filter((c) => c !== AV.main);
    for (const n of Object.keys(AGENTS)) delete AGENTS[n];
    AV_TAKEN.clear();
  }
  const nameHash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
  function avatar(n) {
    const a = (AGENTS[n] ||= {});
    if (a.av) return a;
    if (n === LEAD) a.av = AV.main;
    else {
      const k = nameHash(n) % VARIANTS.length;
      a.av = VARIANTS.map((_, i) => VARIANTS[(k + i) % VARIANTS.length]).find((x) => !AV_TAKEN.has(x)) || VARIANTS[k];
    }
    a.dup = (AV_TAKEN.get(a.av) || 0) + 1; AV_TAKEN.set(a.av, a.dup);
    a.color = AV.heroes[a.av].color;
    return a;
  }
  const colorOf = (n) => (n && AGENTS[n] ? avatar(n).color : undefined);
  // an agent's hero, small, where its name is shown; it bobs while the agent
  // works. A sheet cast shows the pose of its last call, asleep when it is idle.
  function mascot(n) {
    const a = avatar(n), working = v.acting.has(n), dup = a.dup > 1 ? `<i class="dup">${a.dup}</i>` : "";
    const mood = working ? MOOD[n] || "work" : v.W && idle(n) ? "sleep" : MOOD[n] || "idle";
    return `<span class="av${working ? " bob" : ""}" style="--ac:${a.color};${figureStyle(AV.heroes[a.av], mood)}" title="${esc(n)}" aria-hidden="true">${dup}</span>`;
  }
  const tag = (n) => `<span class="agent-tag" style="--ac:${avatar(n).color}">${mascot(n)}${esc(n)}</span>`;
  const capAvatars = (names, k = 3) => names.slice(0, k).map((n) => mascot(n)).join("") + (names.length > k ? `<span class="plus">+${names.length - k}</span>` : "");

  // ---------------------------------------------------------------- state
  const v = {
    W: null, FM, lineDiff: o.lineDiff, live: !!o.live, project: PROJECT, rightMode: {}, active: "main", follow: true, left: "history", orient: "sideways", note: "",
    acting: new Set(), lastLoc: null, colorOf, render: () => render(), ide: "history",
  };
  const files = createFiles(v);
  // History's dragged width and, when narrow, which window the switch shows:
  // per-viewer conveniences, kept in this browser when it allows.
  const PREF = "lfs-layout";
  const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF)) || {}; } catch { return {}; } })();
  const savePrefs = () => { try { localStorage.setItem(PREF, JSON.stringify(prefs)); } catch { /* not kept */ } };
  // a cast brings its skin: the root's data-skin picks its colours (style.js)
  if (o.casts) { useCast(o.casts[0].avatars); root.dataset.skin = o.casts[0].id; }
  delete prefs.cast; // retired: the Cast switch
  // History and the work window take turns: the Work | History switch at the
  // left of the tab row (prefs.pane) shows one of them, with the whole view to
  // itself; picking a tab from History goes back to Work. (The
  // preview's own layout keeps History inside the work area, both at once.)
  delete prefs.dock; delete prefs.histh; delete prefs.panes; delete prefs.histw; // retired: side by side, arrangements, History's width
  delete prefs.swap; // retired: History was the default; everyone starts on Work again
  // With `o.pane` the host shows Work and History as two tabs of its own (dsh):
  // this view draws that one pane, without the switch or the logo.
  if (o.pane) root.dataset.pane = o.pane; // History drops the Branch strip: a name tag in the tree opens its tab
  if (o.pane && layout.swap) { layout.strip.querySelector(".lfs-logo")?.remove(); layout.swap.remove(); layout.swap = null; }
  const shownPanes = () => o.pane || (!layout.cols ? "both" : prefs.pane === "history" ? "history" : "work"); // Work until the viewer picks History
  const pinned = {}, seenTabs = new Set(["main"]), OPEN_SDK = new Set();
  let sbLit = null, sbPulse = null, focusPane = null, sizeTries = 0;
  // Workspaces unmounted since an earlier render stay LEAVE_MS as a fading
  // trail, by the wall clock: the model drops them at once, and a Workspace a
  // script mounts and unmounts within a second still reads as one that was
  // there. One that mounted and left between two draws (a fast script, Max
  // speed) is found by its pane's `left` step, newer than the last draw's.
  const LEAVE_MS = 3600, leaving = new Map();
  let shownWs = {}, leaveTimer = null, leftSeen = null;
  // a step's entrance animations (a new line, a new pane, a Branch row's
  // flash) play on its first draw only: later redraws (a poll, a tree that
  // loaded, the trail ending) would restart them, a flicker
  let drawnSeq = null, fresh = -1;
  function trackLeaving(W) {
    const now = Date.now();
    for (const [k, w] of Object.entries(shownWs)) if (!W.ws[k] && !leaving.has(k)) leaving.set(k, { w, at: now });
    if (leftSeen !== null && leftSeen <= W.seq) for (const [k, p] of Object.entries(W.panes)) {
      if (p.left > leftSeen && !W.ws[k] && !leaving.has(k) && p.branch) leaving.set(k, { w: { id: k, agent: p.agent, branch: p.branch, lines: p.lines, born: p.born }, at: now });
    }
    leftSeen = W.seq;
    for (const [k, l] of leaving) if (W.ws[k] || now - l.at >= LEAVE_MS) leaving.delete(k);
    shownWs = W.ws;
    clearTimeout(leaveTimer);
    if (leaving.size) leaveTimer = setTimeout(render, Math.max(16, Math.min(...[...leaving.values()].map((l) => l.at + LEAVE_MS - now))));
  }
  const where = (n) => X.where(v.W, n), idle = (n) => X.idle(v.W, n);
  const lastHit = (loc) => (v.lastLoc === loc ? " hot" : "");
  const q = (sel) => root.querySelector(sel);

  // ---------------------------------------------------------------- tabs
  // The website's Branch tabs: a square in the Branch's colour, its name and a
  // chip (main: read-only; a Branch: its mounted Workspaces, a conflict or idle).
  function renderTabs() {
    const W = v.W, { tabs, hidden, retired } = X.visibleTabs(W, { pinned, active: v.active });
    const chip = (b) => {
      const B = W.branches[b], isNew = !seenTabs.has(b); seenTabs.add(b);
      const bad = X.conflicted(W, b), nWs = Object.values(W.ws).filter((w) => w.branch === b).length, dim = branchIdle(b);
      const meta = bad ? `<span class="tchip bad">conflict</span>` : nWs ? `<span class="tchip">${nWs} ws</span>` : dim ? `<span class="tchip">idle</span>` : "";
      return `<button class="tab${bad ? " conflict" : ""}${dim ? " dim" : ""}${isNew ? " enter" : ""}" role="tab" data-tab="${esc(b)}" aria-selected="${b === v.active}" style="--bc:var(${B.color})">
        <span class="sq"></span>${esc(b)}${meta}<span class="pin${pinned[b] ? " on" : ""}" data-pin="${esc(b)}" title="Pin tab">${pinned[b] ? "📌" : "⌖"}</span></button>`;
    };
    layout.tabs.innerHTML = `<button class="tab main" role="tab" data-tab="main" aria-selected="${v.active === "main"}"><span class="sq"></span>main<span class="tchip ro">read-only</span></button>`
      + tabs.map(chip).join("") + (hidden.length || retired.length ? `<button class="tab more${hidden.length ? "" : " retired"}" data-more="1" title="${hidden.length} idle Branch${hidden.length === 1 ? "" : "es"} · ${retired.length} retired (nobody on them for over ${X.RETIRE_S} s)">${hidden.length ? `+${hidden.length}` : `${retired.length} retired`}</button>` : "");
    // the strip is one line that scrolls sideways: keep the open tab in view
    const strip = layout.tabs, on = strip.querySelector('[aria-selected="true"]'), more = strip.querySelector(".more");
    if (on && strip.scrollWidth > strip.clientWidth) {
      const end = strip.clientWidth - (more ? more.offsetWidth + 4 : 0);
      if (on.offsetLeft < strip.scrollLeft) strip.scrollLeft = on.offsetLeft;
      else if (on.offsetLeft + on.offsetWidth > strip.scrollLeft + end) strip.scrollLeft = on.offsetLeft + on.offsetWidth - end;
    }
  }

  // ---------------------------------------------------------------- terminals
  // A line's operation, for the maids' notebook hand (skins/maids/style.js): what
  // its pencil, highlighter, stamp, ruler, margin vine or bracket draws. A call
  // counts only when it did what it names; a failure is just written.
  const OPS = { "project.init": ["init", "Initialized"], "branch.fork": ["fork", "Forked"], "main.fork": ["fork", "Forked"], "branch.merge": ["merge", "Merged"],
    "branch.publish": ["publish", "Added"], "sandbox.mount": ["mount", "Mounted"], "sandbox.commit": ["commit", "Committed"], "sandbox.unmount": ["unmount", "Unmounted"] };
  function opOf(l) {
    const c = l.calls || [];
    for (const x of c) { const op = OPS[x.call]; if (op && x.code === op[1]) return op[0]; }
    return c.some((x) => x.call.startsWith("fs.")) ? (l.dim ? "read" : "write") : "";
  }
  const outMatch = (l, re) => { for (const x of l.out || []) { const m = re.exec(x.t); if (m) return m[1]; } return null; };
  // `marks`: the spans this line belongs to ({ cls, first, last, fresh }), drawn in the margin:
  // a Commit's bracket, an fs script's group. Every part of the line carries `cls`; the
  // command line of the first adds cls0, the last part of the last cls1.
  function lineHtml(l, isNew, prefix, marks = []) {
    const c = l.calls || [], key = String(l.t) + (l.text || ""), op = opOf(l);
    const sdk = c.length ? `<button class="sdkbtn" data-sdk="${esc(key)}" title="Show the SDK call and inline Node script">sdk${c.length > 1 ? " ×" + c.length : ""}</button><div class="sdk">${c.map((x) => `<span class="code"><b>${esc(x.call)}</b> → ${esc(x.code)}<span class="tm">${esc(timingText(x.timing))}</span></span>${x.script ? `<pre>${esc(x.script)}</pre>` : ""}`).join("")}</div>` : "";
    const grp = l.group ? `<span class="grp" title="event group: these calls come from one script of ${esc(l.agent || "this agent")}">⧉ ${esc(l.group)}</span>` : "";
    const who = l.agent && !l.dim ? mascot(l.agent) : "";
    // one row: the command shortens with "…" (the whole of it is its hint) and its time stays in view;
    // a new command types itself out (--n characters over --d), then its output and time appear
    const n = l.text ? [...l.text].length : 0, type = isNew && n && !l.dim ? ` style="--n:${n};--d:${Math.min(700, Math.max(140, n * 14))}ms"` : "";
    const sdkBtn = sdk.slice(0, sdk.indexOf("<div")), sdkBox = sdk.slice(sdk.indexOf("<div"));
    // the notebook's marks: a ruler under the project's start and each publish, the
    // Commit's and the publish's ids as a sticker and a seal, a fork's or merge's
    // Branch colour for its margin vine, a read's highlighter time
    if (op === "init" || op === "publish") marks = [...marks, { cls: "ru", first: true, last: true, fresh: isNew }];
    const bname = op === "fork" ? outMatch(l, /^(\S+) ←/) : op === "merge" ? outMatch(l, /→ (\S+) @/) : null, bc = bname && v.W.branches[bname];
    const vars = [type ? type.slice(8, -1) : isNew && op === "read" && n ? `--d:${Math.min(600, Math.max(200, n * 12))}ms` : "", bc ? `--bc:var(${bc.color})` : ""].filter(Boolean).join(";");
    const tag = op === "commit" ? outMatch(l, /^Committed (\S+)/) : op === "publish" ? outMatch(l, /@ (\S+)$/) : null;
    const pin = tag ? `<span class="${op === "commit" ? "stk" : "seal"}">${esc(tag)}</span>` : "";
    const last = (l.out || []).length, part = (k) => marks.map((m) => ` ${m.cls}${m.first && k === 0 ? ` ${m.cls}0` : ""}${m.last && k === last ? ` ${m.cls}1` : ""}${m.fresh ? ` ${m.cls}new` : ""}`).join("");
    return `<div class="ln${op ? " op-" + op : ""}${l.dim ? " dim" : ""}${isNew ? " new" : ""}${type ? " typing" : ""}${OPEN_SDK.has(key) ? " open" : ""}${part(0)}"${vars ? ` style="${vars}"` : ""}><div class="lrow">${prefix}${grp}${l.text ? `<span class="cmd" title="${esc(l.text)}">${esc(l.text)}</span>${type ? '<i class="pen" aria-hidden="true"></i>' : ""}` : ""}${pin}${who}${cmdTime(c)}${sdkBtn}</div>${c.length ? sdkBox : ""}</div>`
      + (l.out || []).map((x, k) => `<span class="out${x.c ? " " + x.c : ""}${isNew ? " ln new" : ""}${part(k + 1)}"${type} title="${esc(x.t)}">${esc(x.t)}</span>`).join("");
  }
  // The margin spans of a terminal's shown lines: in a Workspace, each Commit's
  // bracket around the calls it captured (from the first command after the last
  // Commit; lines not yet committed have none); in an fs terminal, each script's
  // group of calls, solid when it wrote, dotted when it only read.
  function spansOf(shown, kind) {
    const marks = shown.map(() => []);
    if (kind === "ws") {
      let start = 0;
      shown.forEach((l, i) => {
        if (opOf(l) !== "commit") return;
        let s = start; while (s < i && shown[s].dim) s++;
        for (let k = s; k <= i; k++) marks[k].push({ cls: "cm", first: k === s, last: k === i, fresh: l.t === fresh });
        start = i + 1;
      });
    } else if (kind === "fs") {
      for (let i = 0; i < shown.length;) {
        const g = shown[i].group; let j = i;
        while (g && j + 1 < shown.length && shown[j + 1].group === g) j++;
        const cls = shown.slice(i, j + 1).every((l) => l.dim) ? "gr" : "gw";
        if (j > i) for (let k = i; k <= j; k++) marks[k].push({ cls, first: k === i, last: k === j });
        i = j + 1;
      }
    }
    return marks;
  }

  // ---------------------------------------------------------------- History
  // The left panel, on every tab: the project's tree, or Files of the open
  // tab's head (history.js, which the project board draws alone).
  const hist = createHistory({
    root, v, files, avatar, mascot,
    head: (n) => headSvg(AV.heroes[avatar(n).av], esc(n)),
    visit: (by, id, node) => visitNode(by, id, nodeMood(node)),
    openAt: (lane, id, mode) => {
      // a project page has one tab and looks at any node there; a conversation opens the node's Branch
      const tab = PROJECT ? "main" : lane;
      if (!PROJECT) { v.active = lane; setFollow(false); }
      files.showAt(tab, id);
      files.filesOf(tab).mode = mode === "blame" ? "blame" : "view";
      v.ide = "file";
      render();
    },
  });
  const branchIdle = hist.branchIdle;
  function rosterMenu(anchor) {
    const W = v.W, label = (n) => { const l = where(n), A = W.agents[n];
      return l.kind === "ws" ? `${l.branch} · ${l.ws}` : l.kind === "fs" ? `${l.branch} · fs` : l.kind === "hist" ? "project terminal"
        : A.lastBranch ? `idle · last on ${A.lastBranch}` : "idle"; };
    const all = Object.keys(W.agents).sort((x, y) => idle(x) - idle(y));
    openMenu(anchor, "roster-menu", all.map((n) => { const l = where(n);
      return `<button ${l.branch ? `data-open="${esc(l.branch)}"` : ""}>${mascot(n)}<b style="color:${avatar(n).color}">${esc(n)}</b><span style="margin-left:auto;font:11px var(--mono);color:var(--text-3)">${esc(label(n))}</span></button>`; }).join(""), 300);
  }
  function openMenu(anchor, cls, inner, width) {
    closeMenu();
    const r = anchor.getBoundingClientRect(), base = root.getBoundingClientRect(), m = document.createElement("div");
    m.className = "menu " + cls; m.innerHTML = inner;
    m.style.top = r.bottom - base.top + 4 + "px";
    m.style.left = Math.max(8, (width ? r.right - width : r.left) - base.left) + "px";
    root.appendChild(m);
  }
  // the tabs' "+N" (and the board's "retired"): hidden Branches, then retired ones
  function moreMenu(anchor) {
    const { hidden, retired } = X.visibleTabs(v.W, { pinned, active: v.active });
    openMenu(anchor, "", branchItems(hidden) + (retired.length ? `<div class="mhead">retired · nobody on them for over ${X.RETIRE_S} s</div>${branchItems(retired)}` : ""));
  }
  const branchItems = (list) => list.map((b) => { const age = v.W.clock - v.W.branches[b].last;
    return `<button data-open="${esc(b)}"><span class="dot" style="width:8px;height:8px;border-radius:50%;background:var(${v.W.branches[b].color})"></span>${esc(b)}<span class="mt">${age}s</span></button>`; }).join("");
  const closeMenu = () => { const m = root.querySelector(".menu"); if (m) m.remove(); };

  // The website's terminal window parts: a faint LayerFS stamp behind the
  // output, the fs icon, a tag, and a terminal (head, stamp, lines).
  const STAMP = (lines) => `<svg class="wm" viewBox="0 0 320 ${224 + lines.length * 30}" aria-hidden="true"><g transform="translate(60 -10)" opacity="0.1"><path d="M88.5 22 L111.5 22 L170 135 L148.5 135 L100 49.5 L51.5 135 L30 135 Z" fill="#93B1E0" stroke="#93B1E0" stroke-width="2" stroke-linejoin="round"/><path d="M27 161 L57 161 L100 117 L143 161 L173 161" fill="none" stroke="#2F5BB5" stroke-width="10.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="100" cy="117" r="15.5" fill="#2F5BB5"/><circle cx="27" cy="161" r="15.5" fill="#2F5BB5"/><circle cx="173" cy="161" r="15.5" fill="#2F5BB5"/></g><text x="160" y="214" text-anchor="middle" font-size="36" font-weight="600" fill="#2F5BB5" opacity="0.16">LayerFS</text>`
    + lines.map((l, k) => `<text x="160" y="${248 + k * 30}" text-anchor="middle" font-size="24" font-weight="500" fill="#2F5BB5" opacity="0.2">${esc(l)}</text>`).join("") + `</svg>`;
  const FSICON = (c) => `<svg class="fsi" width="18" height="18" viewBox="-1 -1 10 10" shape-rendering="crispEdges" aria-hidden="true"><rect x="-1" y="-1" width="10" height="10" style="fill:${c}"/><path fill="#fff" d="M1 1h6v1H1zM1 3h6v1H1zM1 5h6v1H1zM6 6h1v1H6z"/></svg>`;
  const TAG = (tone, text) => `<span class="wtag ${tone}">${esc(text)}</span>`;
  const HINT = (text) => `<span class="hint-i" tabindex="0" role="note" title="${esc(text)}" aria-label="${esc(text)}">i</span>`;
  const BOXICON = `<svg class="boxi" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.5 12.5 4v6L7 12.5 1.5 10V4Z M1.5 4 7 6.5 12.5 4 M7 6.5v6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  // "sha256:091f…ee9d2" → "sha256:091f785b", a tag stays as given
  const shortImage = (img) => (/^sha256:[0-9a-f]{12,}$/.test(img) ? img.slice(0, 15) : img.length > 28 ? img.slice(0, 27) + "…" : img);
  const term = (cls, attrs, head, stamp, body) => `<section class="term wterm${cls}" ${attrs}><div class="thead">${head}</div><div class="tbox">${STAMP(stamp)}<div class="tbody" data-scroll>${body}</div></div></section>`;
  // What an agent is doing on a Branch, for its chip or card row: "ws/2 exec", "fs", "idle".
  function stateOf(n) {
    const l = where(n);
    return l.kind === "ws" ? `${l.ws.split(":")[1].replace("/workspaces/", "ws/")}${idle(n) ? "" : " exec"}` : l.kind === "fs" ? "fs" : l.kind === "hist" ? "project" : "idle";
  }
  const busyOn = (n, b) => { const l = where(n); return l.branch === b && l.kind !== "bench"; };
  // agents a Branch shows: on it now, holding a Workspace there, or recently here
  const castOf = (b) => [...new Set([...X.agentsOn(v.W, b), ...Object.values(v.W.ws).filter((w) => w.branch === b).map((w) => w.agent), ...X.recentlyOn(v.W, b)])];

  // main is read-only: the Sandboxes and the Branches (each a card on the
  // sand floor, with its agents) on the left; the Store and the project
  // terminal on the right. A Branch nobody has been on for RETIRE_S retires
  // from the board (pinned ones stay); the tabs' "+N" menu still lists it.
  // Branches and their Sandboxes in one box. A Branch card lists the
  // Workspaces mounted on it, one row each, with the Sandbox it is mounted in
  // as a chip (hover: the Sandbox's record and every row in it), the agents
  // on it without a Workspace, and the processes running in its Workspaces.
  // Every Sandbox (open, or closed in the last RETIRE_S), mounted or not, is
  // listed in a card that opens over the header's count.
  const sinceClock = (t) => (t == null ? "–" : v.W.clock - t < 1 ? "now" : `${v.W.clock - t}s ago`);
  /** A Sandbox's whole record, for its chip's hover. */
  function sbHint(id) {
    const W = v.W, s = W.engine.s, sb = s.sandboxes[id], a = (W.sbAt || {})[id] || {}, who = (W.sbBy || {})[id] || {}, real = W.engine.m?.toReal?.get(id);
    const wss = sb.wsOrder.filter((p) => sb.workspaces[p].mounted).map((p) => ({ p, w: sb.workspaces[p], view: W.ws[`${id}:${p}`] }));
    const procs = sb.closed ? [] : sb.procOrder.map((p) => sb.processes[p]).filter((p) => p.status === "running");
    return [`Sandbox ${id}${real && real !== id ? ` (${real})` : ""}`, sb.closed ? `closed ${sinceClock(a.closed)}${who.closed ? ` by ${who.closed}` : ""}` : `open · used ${sinceClock(a.last)}`,
      who.made ? `made by ${who.made}${who.service ? " (a service)" : ""}${a.made != null ? ` ${sinceClock(a.made)}` : ""}` : null,
      a.image ? `image ${a.image}` : null,
      a.calls ? `${a.calls} call${a.calls === 1 ? "" : "s"} · ${a.execs || 0} command${a.execs === 1 ? "" : "s"}` : null,
      ...wss.map(({ p, w, view }) => `${p} → ${w.branch}${w.baseCommit ? ` @ ${w.baseCommit}` : ""}${view ? ` · ${view.agent}` : ""}${w.dirty ? ` · ${w.dirty} dirty` : ""}${w.stale ? " · head moved since mount" : ""}${w.pendingMerge ? " · merge pending" : ""}`),
      ...procs.map((p) => `● ${p.command} (${p.path})`)].filter(Boolean).join("\n");
  }
  /** A Sandbox as a chip; the project's prefix gives way first ("layerfs-shop-1", "demo-ag…checkout"). */
  function sbChip(id, extra, bare) {
    const s = v.W.engine.s, sb = s.sandboxes[id], project = s.project ? s.project.name : "";
    const pre = (project ? [`layerfs-${project}-`, `${project}-`] : []).find((p) => id.startsWith(p) && id.length > p.length) ?? "";
    return `<span class="sbc${sb.closed ? " closed" : ""}" data-sbid="${esc(id)}" data-sbhl="${esc(id)}"${bare ? "" : ` title="${esc(sbHint(id))}"`}>${BOXICON}${pre ? `<span class="pre">${esc(pre)}</span>` : ""}<b>${esc(id.slice(pre.length))}</b>${extra || ""}</span>`;
  }
  /** The header count's card: every Sandbox, open first, with its record. */
  function sbList() {
    const W = v.W, s = W.engine.s, at = W.sbAt || {}, by = W.sbBy || {};
    const ids = s.sandboxOrder.filter((id) => !s.sandboxes[id].closed || (at[id]?.closed != null && W.clock - at[id].closed <= X.RETIRE_S))
      .sort((x, y) => (s.sandboxes[x].closed - s.sandboxes[y].closed) || ((at[y]?.last ?? 0) - (at[x]?.last ?? 0)));
    if (!ids.length) return `<div class="sbli">no Sandbox open · LayerFS starts one when a Workspace is mounted</div>`;
    const pl = (k, one) => `${k} ${one}${k === 1 ? "" : "s"}`;
    return ids.map((id) => {
      const sb = s.sandboxes[id], a = at[id] || {}, who = by[id] || {};
      const meta = [who.made ? `made by ${who.made}${who.service ? " (a service)" : ""}` : null, a.image ? shortImage(a.image) : null, a.calls ? pl(a.calls, "call") : null, a.execs ? pl(a.execs, "cmd") : null].filter(Boolean).join(" · ");
      const wss = sb.wsOrder.filter((p) => sb.workspaces[p].mounted).map((p) => {
        const w = sb.workspaces[p], view = W.ws[`${id}:${p}`];
        return `${p.replace("/workspaces/", "ws/")} → ${w.branch}${view ? ` · ${view.agent}` : ""}${w.dirty ? ` · ${w.dirty} dirty` : ""}${w.stale ? " · stale" : ""}`;
      });
      const procs = sb.closed ? [] : sb.procOrder.map((p) => sb.processes[p]).filter((p) => p.status === "running").map((p) => `● ${p.command}`);
      const lines = [...wss, ...procs].map((l) => `<div class="sbm l">${esc(l)}</div>`).join("") || (sb.closed ? "" : `<div class="sbm">no Workspace mounted</div>`);
      return `<div class="sbli${sb.closed ? " closed" : ""}" data-sbhl="${esc(id)}">${sbChip(id, "", true)}<span class="sbst${sb.closed ? "" : " on"}">${esc(sb.closed ? `closed ${sinceClock(a.closed)}` : `used ${sinceClock(a.last)}`)}</span>${meta ? `<div class="sbm">${esc(meta)}</div>` : ""}${lines}</div>`;
    }).join("");
  }
  function boardHtml() {
    const W = v.W, s = W.engine.s, placed = new Set();
    // every mounted Workspace in a Sandbox still open, by Branch
    const wsOn = {};
    for (const id of s.sandboxOrder) {
      const sb = s.sandboxes[id];
      if (sb.closed) continue;
      for (const p of sb.wsOrder) {
        const w = sb.workspaces[p];
        if (!w.mounted) continue;
        (wsOn[w.branch] ||= []).push({ id, p, w, key: `${id}:${p}`, view: W.ws[`${id}:${p}`], procs: sb.procOrder.map((k) => sb.processes[k]).filter((x) => x.status === "running" && x.path === p) });
      }
    }
    const live = W.order.filter((b) => pinned[b] || wsOn[b] || !X.retired(W, b)), nRetired = W.order.length - live.length;
    const cards = live.sort((x, y) => W.branches[y].last - W.branches[x].last).map((b) => {
      const B = W.branches[b], bad = X.conflicted(W, b), dim = branchIdle(b), cast = castOf(b), age = W.clock - B.last;
      const head = B.head.startsWith("fork:") ? `from ${B.base}` : B.head;
      const note = bad ? "conflict" : B.published ? `${head} · ↑ ${W.mainHead}` : `${head} · ${age < 1 ? "now" : age + "s"}`;
      cast.forEach((n) => placed.add(n));
      const wss = wsOn[b] || [], withWs = new Set(wss.map((x) => x.view && x.view.agent).filter(Boolean));
      const wsRows = wss.map(({ id, p, w, key, view, procs }) => {
        const n = view && view.agent, on = n && busyOn(n, b), name = p.replace("/workspaces/", "ws/");
        // the row already names the Workspace: its state alone ("exec"), or "mounted"
        const st = !n ? "mounted" : !on ? "idle" : stateOf(n).startsWith(name) ? stateOf(n).slice(name.length).trim() || "mounted" : stateOf(n);
        const tip = `${p} in ${id}: ${b} from ${w.baseCommit || w.baseLayer || "main"}${w.dirty ? ` · ${w.dirty} changed entries not yet committed` : ""}${view ? " · click: its pane" : ""}`;
        return `<div class="crow ws${n && !on ? " off" : ""}"${view ? ` data-dws="${esc(key)}"` : ""} data-sbhl="${esc(id)}" style="--ac:${n ? avatar(n).color : "var(--text-3)"}" title="${esc(tip)}">${n ? mascot(n) : ""}<span class="nm">${esc(n || name)}</span>${sbChip(id, `<span class="wsn">${esc(name)}</span>`)}`
          + `${w.dirty ? `<span class="dt">${w.dirty} dirty</span>` : ""}${w.stale ? `<span class="dt warn">stale</span>` : ""}<span class="st">${esc(st)}</span></div>`
          + procs.map((x) => `<div class="sbproc" title="${esc(`${x.command} · ${x.path} in ${id} · process ${x.id}`)}"><span class="d"></span>${esc(x.command)}</div>`).join("");
      }).join("");
      const agentRows = cast.filter((n) => !withWs.has(n)).map((n) => {
        const on = busyOn(n, b);
        return `<div class="crow${on ? "" : " off"}" style="--ac:${avatar(n).color}">${mascot(n)}<span class="nm">${esc(n)}</span><span class="st">${esc(on ? stateOf(n) : "idle")}</span></div>`;
      }).join("");
      return `<div class="bcard${dim ? " dim" : ""}${bad ? " bad" : ""}${B.last === W.clock && W.seq && fresh === W.seq ? " flash" : ""}" style="--bc:var(${B.color})"><div class="bhd" data-open="${esc(b)}" title="Open ${esc(b)}"><span class="sq"></span><span class="nm">${esc(b)}</span><span class="note">${esc(note)}</span></div>${wsRows}${agentRows}</div>`;
    }).join("");
    const pool = Object.keys(W.agents).filter((n) => !placed.has(n) && where(n).kind === "bench");
    const all = Object.keys(W.agents), nIdle = all.filter((n) => idle(n)).length;
    const nOpen = s.sandboxOrder.filter((id) => !s.sandboxes[id].closed).length, nWs = Object.keys(W.ws).length;
    const none = nRetired ? `every Branch has retired · nobody on one for over ${X.RETIRE_S} s` : "no Branch yet · an agent forks one from main";
    return `<section class="board"><div class="bhead"><span class="t">branches</span><span>${live.length}</span>${HINT(`Branches and their Sandboxes. A Branch is a line of Commits forked from main; a Sandbox is a Linux container where an agent mounts Workspaces (each a full view of one Branch) and runs commands. A card shows the Branch's head (or the main Layer it was published to), each Workspace mounted on it with its Sandbox (hover the Sandbox for its record and every Workspace in it; click a row for its pane; hover the count for every Sandbox), and the agents on it now or in the last ${RECENT_S} s. A Branch nobody has been on for ${X.RETIRE_S} s retires from this board and the tabs (pin a tab to keep it); a closed Sandbox stays ${X.RETIRE_S} s.`)}<span class="sp"></span><span class="sbsum" tabindex="0" aria-label="Sandboxes: hover or focus for each one">${TAG("blue", `${nWs} workspace${nWs === 1 ? "" : "s"} · ${nOpen} sandbox${nOpen === 1 ? "" : "es"}`)}<div class="sbpop" role="tooltip">${sbList()}</div></span>${nRetired ? `<button class="roster" data-more="1" title="Branches nobody has been on for over ${X.RETIRE_S} s: still in History">${nRetired} retired</button>` : ""}<button class="roster" data-roster="1" title="All agents">${nIdle} idle</button></div>
      <div class="floor">${cards ? `<div class="stack">${cards}</div>` : `<div class="none">${none}</div>`}</div>
      ${pool.length ? `<div class="pool"><span>unassigned</span>${pool.map((n) => mascot(n)).join("")}</div>` : ""}</section>`;
  }
  // Store totals as the operator's store.stats reports them, for the whole project.
  function storePanel() {
    const W = v.W, z = W.engine.storage(), s = W.engine.s;
    const x = (a, b) => (b > 0 ? `${(a / b).toFixed(a / b >= 10 ? 0 : 1)}×` : "–");
    const tile = (val, label, tone) => `<div class="tile"><span>${label}</span><b class="${tone}">${esc(val)}</b></div>`;
    const nC = Object.keys(s.commits).length, nL = Object.keys(s.layers).length;
    const pct = (a) => (z && z.store > 0 ? Math.max(0, Math.min(100, (a / z.store) * 100)).toFixed(1) : 0);
    const free = z ? Math.max(0, z.store - z.stored - z.metadata) : 0;
    if (z && z.counts) return `<section class="term storep">${storeHead()}${storeBody(z, x)}</section>`;
    return `<section class="term storep"><div class="thead">${FSICON("var(--accent)")}<span class="t" title="the project's Store, as the operator's store.stats reports it">storage</span><span class="sp"></span>${TAG("coral", "main · read-only")}</div>
      <div class="sbody"><div class="tiles">${tile(z ? x(z.logical, z.payload) : "–", "dedupe", "blue")}${tile(z ? x(z.payload, z.stored) : "–", "compression", "coral")}${tile(z ? fmtBytes(z.stored) : "–", "stored", "")}${tile(z ? fmtBytes(z.store) : "–", "file", "")}</div>
      <div class="sbar2"><span class="p" style="width:${pct(z ? z.stored : 0)}%"></span><span class="m" style="width:${pct(z ? z.metadata : 0)}%"></span><span class="f" style="width:${pct(free)}%"></span></div>
      <div class="sline">${z ? `logical <b>${fmtBytes(z.logical)}</b> · canonical <b>${fmtBytes(z.payload)}</b> · <span class="mc">metadata</span> ${fmtBytes(z.metadata)} · ` : `${v.live ? "not reported yet" : nC ? "sizes not reported" : "empty"} · `}${nC} commit${nC === 1 ? "" : "s"} · ${nL} layer${nL === 1 ? "" : "s"}${z && z.estimate ? " · Mocked LayerFS estimate" : ""}</div></div></section>`;
  }
  const storeHead = () => `<div class="thead">${FSICON("var(--accent)")}<span class="t" title="the project's Store, as the operator's store.stats reports it">storage</span><span class="sp"></span>${TAG("coral", "main · read-only")}</div>`;
  // The live Store against one plain copy of main's head: the full-copy history,
  // what dedupe and compression leave, the metadata, then what each Commit added.
  function storeBody(z, x) {
    const n = z.counts, top = Math.max(1, ...[z.head, z.logical, z.payload, z.stored, z.metadata].filter((v) => v != null));
    const row = (label, bytes, cls) => `<span class="lb">${label}</span><span class="bw"><span class="${cls}" style="width:${bytes == null ? 0 : Math.max(0.6, (bytes / top) * 100).toFixed(1)}%"></span></span><span class="vl">${bytes == null ? "–" : fmtBytes(bytes)}</span>`;
    const costs = z.perCommit || [], sum = costs.reduce((a, c) => a + c.bytes, 0), max = Math.max(1, ...costs.map((c) => c.bytes));
    const bars = costs.map((c) => `<span class="${c.via === "fs" ? "fs" : c.via === "exec" ? "ws" : "ot"}" style="height:${Math.max(4, (c.bytes / max) * 100).toFixed(0)}%" title="${esc(c.via || "commit")} · ${fmtBytes(c.bytes)} new"></span>`).join("");
    return `<div class="sbody sv2">
      <div class="shead"><b>${fmtBytes(z.store)}</b><span>on disk for ${fmtBytes(z.logical)} of history</span></div>
      <div class="ssub">${n.commits} Commit${n.commits === 1 ? "" : "s"} · ${n.branches} Branch${n.branches === 1 ? "" : "es"} · ${n.layers} Layer${n.layers === 1 ? "" : "s"}, each a full snapshot</div>
      <div class="srows">${row("main, latest, raw", z.head, "hd")}${row("every snapshot, raw", z.logical, "fc")}${row("unique", z.payload, "dd")}${row("unique, compressed", z.stored, "cp")}${row("+ metadata", z.metadata, "md")}</div>
      <div class="snote">${x(z.logical, z.payload)} dedupe · ${x(z.payload, z.stored)} compression${z.baseline ? ` · ${fmtBytes(z.baseline)} from Init${z.imported ? ` (${z.imported} file${z.imported === 1 ? "" : "s"} imported)` : ", the empty Store's baseline"}` : ""}</div>
      ${costs.length ? `<div class="scost"><span class="lb">per Commit</span><span><b>${fmtBytes(sum / costs.length)}</b> average</span><span><b>${fmtBytes(max)}</b> largest</span></div>
      <div class="sbars">${bars}</div>
      <div class="snote"><span class="k fs"></span>fs write <span class="k ws"></span>Workspace commit · newest ${costs.length}, oldest left</div>` : ""}</div>`;
  }
  // A project page's Storage tab: the same figures as the storage panel, laid
  // out for a whole pane and without its terminal box: the size on disk and
  // its ratios across the top, then where the bytes go beside what each
  // Commit added (wrapping under it when narrow).
  function storePage() {
    const z = v.W.engine.storage(), n = z.counts || {};
    const x = (a, b) => (b > 0 ? `${(a / b).toFixed(a / b >= 10 ? 0 : 1)}×` : "–");
    const fact = (val, label, tip) => `<div class="sp-fact" title="${esc(tip)}"><b>${esc(val)}</b><span>${esc(label)}</span></div>`;
    const plural = (k, one, many) => `${k ?? 0} ${k === 1 ? one : many}`;
    const top = Math.max(1, ...[z.head, z.logical, z.payload, z.stored, z.metadata].filter((b) => b != null));
    const row = (label, bytes, cls, tip) => bytes == null ? "" : `<span class="lb" title="${esc(tip)}">${label}</span><span class="bw"><span class="${cls}" style="width:${Math.max(0.6, (bytes / top) * 100).toFixed(1)}%"></span></span><span class="vl">${fmtBytes(bytes)}</span>`;
    const costs = z.perCommit || [], sum = costs.reduce((a, c) => a + c.bytes, 0), max = Math.max(1, ...costs.map((c) => c.bytes));
    const kind = (c) => (c.via === "fs" ? "fs" : c.via === "exec" ? "ws" : "ot");
    const bars = costs.map((c) => `<span class="${kind(c)}" style="height:${Math.max(3, (c.bytes / max) * 100).toFixed(0)}%" title="${esc([c.label, c.message, `${c.via === "fs" ? "fs write" : c.via === "exec" ? "Workspace commit" : c.via || "commit"} · ${fmtBytes(c.bytes)} new`].filter(Boolean).join(" · "))}"></span>`).join("");
    return `<div class="sv2 spage">
      <div class="sp-top">
        <div class="sp-disk"><div><b>${fmtBytes(z.store)}</b><span>on disk</span></div><p>${plural(n.commits, "Commit", "Commits")} · ${plural(n.branches, "Branch", "Branches")} · ${plural(n.layers, "Layer", "Layers")}, each a full snapshot</p></div>
        <div class="sp-facts">${fact(fmtBytes(z.logical), "history, raw", "every Commit's and Layer's files at full size")}${fact(x(z.logical, z.payload), "dedupe", "every snapshot, raw, over the unique content")}${fact(x(z.payload, z.stored), "compression", "unique content over its packed size")}</div>
      </div>
      <div class="sp-cols">
        <section><h4>Where the bytes go</h4>
          <div class="srows">${row("main, latest", z.head, "hd", "one plain copy of main's head")}${row("every snapshot", z.logical, "fc", "the whole history as plain files")}${row("unique", z.payload, "dd", "each distinct file and chunk once")}${row("compressed", z.stored, "cp", "that content packed")}${row("metadata", z.metadata, "md", "trees, Commits and the database around the packs")}</div>
          ${z.baseline ? `<p class="snote">${fmtBytes(z.baseline)} of it came from Init${z.imported ? `, which imported ${z.imported} file${z.imported === 1 ? "" : "s"}` : ""}.</p>` : ""}
        </section>
        <section><h4>What each Commit added</h4>
          ${costs.length ? `<div class="sp-cost"><span><b>${fmtBytes(sum / costs.length)}</b> average</span><span><b>${fmtBytes(max)}</b> largest</span><span>${costs.length} newest</span></div>
          <div class="sbars">${bars}</div>
          <div class="snote"><span class="k fs"></span>fs write<span class="k ws"></span>Workspace commit<span class="sp-old">oldest on the left</span></div>` : `<p class="snote">No Commit yet.</p>`}
        </section>
      </div>
    </div>`;
  }
  // The main tab: three boxes, always in this order: storage, Branches with
  // their Sandboxes, the project log; storage over Branches on the left
  // and the log on the right, or one under another when narrow.
  function mainView() {
    const W = v.W, project = W.engine.s.project ? W.engine.s.project.name : "no project yet";
    const lines = W.hist.map((l) => lineHtml(l, l.t === fresh, '<span class="prompt">$ </span>')).join("") || `<span class="out">no calls yet</span>`;
    return storePanel() + boardHtml() + term(lastHit("hist"), 'data-loc="hist"', `${mascot(LEAD)}<span class="t">project</span><span class="ghost">${esc(project)}</span><span class="sp"></span>${TAG("blue", "project · branch")}`, ["project · branch"], lines);
  }

  const KEEP = 12; // lines a Branch's fs and Workspace terminals show
  // A terminal keeps a fixed size: only its newest lines, starting at a command,
  // with a count of the calls before them.
  function tailHtml(all, prompt, kind) {
    let cut = Math.max(0, all.length - KEEP);
    while (cut > 0 && cut < all.length && all[cut].dim) cut++;
    const calls = all.slice(0, cut).filter((l) => !l.dim).length;
    return (calls ? `<div class="ln dim fsmore">… ${calls} earlier call${calls === 1 ? "" : "s"}</div>` : "")
      + ((shown) => { const marks = spansOf(shown, kind); return shown.map((l, i) => lineHtml(l, l.t === fresh, l.dim ? "" : prompt, marks[i])).join(""); })(all.slice(cut));
  }
  function branchView(b) {
    const W = v.W, B = W.branches[b];
    const fsLines = tailHtml(W.fsLog[b] || [], '<span class="prompt">$ </span>', "fs") || `<span class="out">no fs calls on ${esc(b)} yet</span>`;
    const headId = B.head.startsWith("fork:") ? B.base : B.head;
    const gone = [...leaving.values()].filter((l) => l.w.branch === b).map((l) => ({ ...l.w, leftAt: l.at }));
    const wss = [...Object.values(W.ws).filter((w) => w.branch === b), ...gone].sort((x, y) => x.born - y.born);
    const nC = Object.values(W.nodes).filter((n) => n.branch === b && n.kind === "commit").length;
    const chips = castOf(b).map((n) => { const on = busyOn(n, b);
      return `<div class="wchip${on ? " on" : ""}" style="--ac:${avatar(n).color}">${mascot(n)}<span class="nm">${esc(n)}</span><span class="st">${esc(on ? stateOf(n) : "idle")}</span></div>`; }).join("");
    const fs = term(" cap" + lastHit("fs:" + b), `data-loc="fs:${esc(b)}"`, `${FSICON(`var(${B.color})`)}<span class="t">fs · ${esc(b)}</span><span class="ghost">persistent</span><span class="sp"></span>${TAG("grey", "direct to Store")}`, ["fs · " + b, "direct to Store"], fsLines);
    const panes = wss.map((w) => { const [sb, path] = w.id.split(":"), ws = path.replace("/workspaces/", "ws/");
      const cls = " cap" + (w.leftAt ? " leaving" : w.bad ? " bad" : lastHit("ws:" + w.id)) + (!w.leftAt && w.born === fresh ? " enter" : "") + (focusPane === w.id ? " focus" : "");
      const pill = w.leftAt ? TAG("grey", ws + " · unmounted") : w.bad ? TAG("coral", ws + " · conflict") : TAG("blue", ws + " · mounted");
      return term(cls, `data-loc="ws:${esc(w.id)}" data-sb="${esc(sb)}" data-sbhl="${esc(sb)}"${w.leftAt ? ` style="animation-delay:${w.leftAt - Date.now()}ms;--ld:${w.leftAt - Date.now()}ms"` : ""}`,
        `${mascot(w.agent)}<span class="t">${esc(w.agent)}</span><button class="ghost sbchip" data-sbchip="${esc(sb)}" title="Runs in Sandbox ${esc(sb)} · click: its cards on main">sandbox ${esc(sb)}</button><span class="sp"></span>${pill}`,
        ["sandbox " + sb, "workspace " + ws], tailHtml(w.lines, '<span class="prompt">$ </span>', "ws")); });
    // one notebook page: the fs log fills it; each Workspace splits it, two blocks across, three
    // as fs beside two stacked, then rows of two (CSS by count). With no Workspace, a faint line
    // at the foot of the page says where one will appear.
    const cells = [fs, ...panes];
    const hint = panes.length ? "" : `<div class="wnone">no Workspace on ${esc(b)} · the page splits here on the next tool call</div>`;
    // one row: its agents' cards, then one sign with the Branch's base, head and Commits (the tab
    // names the Branch; the panes below show its Workspaces)
    const signs = `<span class="sign" title="${esc(`${b}: forked from ${B.base}, newest Commit ${headId}, ${nC} Commit${nC === 1 ? "" : "s"}`)}">${esc(`${B.base} → ${headId} · ${nC} commit${nC === 1 ? "" : "s"}`)}</span>`;
    return `<div class="wchips">${chips || `<span class="none">nobody on ${esc(b)} in the last ${RECENT_S} s</span>`}<span class="wsigns">${signs}</span></div>
      <div class="wgrid nb n${Math.min(cells.length, 4)}">${cells.join("")}${hint}</div>`;
  }

  // ---------------------------------------------------------------- History | Work switch
  // The hidden window gets a dot when it changes: a new History node, or a new
  // step for the work window; showing it clears it.
  const swapSeen = {};
  function renderSwap() {
    const shown = shownPanes(), mark = { history: Object.keys(v.W.nodes).length, work: v.W.seq };
    if (layout.strip) layout.strip.dataset.panes = shown;
    for (const k of ["history", "work"]) if (swapSeen[k] === undefined || k === shown) swapSeen[k] = mark[k];
    if (!layout.swap) return;
    layout.swap.innerHTML = [["work", "Work"], ["history", "History"]].map(([k, l]) => {
      const sel = k === shown, dot = !sel && mark[k] > swapSeen[k];
      return `<button role="tab" class="${sel ? "on" : ""}" data-swap="${k}" aria-selected="${sel}"${dot ? ' title="Changed since you looked"' : ""}>${l}${dot ? '<i class="dot" aria-label="changed"></i>' : ""}</button>`;
    }).join("");
  }

  // ---------------------------------------------------------------- Sandboxes
  // Hovering anything tagged with a Sandbox lights it up: its group on main,
  // and in a Branch tab every pane on that machine.
  function lightSandbox(id) {
    if (id === sbLit) return;
    sbLit = id;
    for (const el of root.querySelectorAll(".sblit")) el.classList.remove("sblit");
    if (id) for (const el of root.querySelectorAll(`.crow[data-sbhl="${CSS.escape(id)}"], .term[data-sb="${CSS.escape(id)}"], .sbc[data-sbid="${CSS.escape(id)}"]`)) el.classList.add("sblit");
  }

  // ---------------------------------------------------------------- render
  // the tree is drawn for its box: when the box turned out another size, draw it again (once)
  function redrawOnce(again) {
    if (again && sizeTries++ < 1) requestAnimationFrame(render);
    else sizeTries = 0;
  }
  // History, like an editor, on a project page and in a conversation alike:
  // Files' tree at a point in a sidebar (the open tab's Branch at its latest
  // head, or a node picked in History), then File, History and Storage tabs.
  // It lives in `host` (a project page's root, else History's panel) and keeps
  // its parts across draws, so the tree and the file keep their scroll.
  function drawIde(host, W) {
    let ide = host.querySelector(":scope > .lfs-ide");
    if (!ide) {
      // added before what the host already holds: on a project page the host is the root,
      // whose overlay (the maids' visits) and History's hover card must stay
      ide = html(`<div class="lfs-ide"><aside class="ide-side" aria-label="Files"></aside><div class="ide-main"><div class="ide-tabs" role="tablist" aria-label="Views"></div><section class="panel hist ide-pane" aria-label="History"></section></div></div>`);
      host.prepend(ide);
    }
    const side = ide.querySelector(".ide-side"), tabsEl = ide.querySelector(".ide-tabs"), pane = ide.querySelector(".ide-pane");
    const show = v.ide, tab = v.active, p = files.filesOf(tab);
    const keep = (el, sel) => { const x = el.querySelector(sel); return x ? x.scrollTop : 0; };
    const restore = (el, sel, top) => { const x = el.querySelector(sel); if (x) x.scrollTop = top; };
    const sideTop = keep(side, ".ftree");
    side.innerHTML = files.sideHtml(tab);
    restore(side, ".ftree", sideTop);
    const name = p.path ? p.path.slice(p.path.lastIndexOf("/") + 1) : "File";
    // Sandboxes: the page's own panel (W.engine.sandboxes), when it gives one, with its level as a dot
    const sbx = W.engine.sandboxes?.();
    const tabs = [["file", name, FILEICON], ["history", "History", HISTICON], ["storage", "Storage", DBICON], ...(sbx ? [["sandboxes", "Sandboxes", BOXICON]] : [])];
    // the sidebar folds away (a per-viewer preference) from a toggle before the tabs
    const hide = !!prefs.sideHidden;
    ide.classList.toggle("side-hidden", hide);
    const toggle = `<button class="ide-toggle" data-ideside="1" aria-pressed="${!hide}" title="${hide ? "Show the file tree" : "Hide the file tree"}" aria-label="${hide ? "Show the file tree" : "Hide the file tree"}">${SIDEICON}</button>`;
    tabsEl.innerHTML = toggle + tabs.map(([k, l, i]) => `<button role="tab" data-ide="${k}" aria-selected="${show === k}" title="${k === "file" && p.path ? esc(p.path) : l}">${i}<span>${esc(l)}</span>${k === "sandboxes" && sbx.level !== "ok" ? `<i class="ide-dot ${sbx.level}" aria-label="${sbx.level}"></i>` : ""}</button>`).join("");
    // History plays only while it is shown: another tab ends the replay, and History comes back at now
    v.rightMode[tab] = show === "history" ? "history" : "files";
    if (show !== "history") hist.stop();
    if (show === "history") {
      const at = hist.keep(), size = hist.size(pane);
      pane.innerHTML = hist.html(size);
      redrawOnce(hist.place(at, size));
    } else if (show === "file") {
      const top = keep(pane, ".fview");
      pane.innerHTML = files.pageHtml(tab);
      restore(pane, ".fview", top);
    } else if (show === "sandboxes" && sbx) {
      // the page's own element, kept across draws so what it draws in it stays
      if (pane.firstElementChild !== sbx.el) pane.replaceChildren(sbx.el);
    } else {
      // the storage panel's figures (engine.storage), as a page
      const z = W.engine.storage();
      pane.innerHTML = `<div class="ide-store">${z ? storePage() : `<div class="fempty">${v.live || W.engine.replay ? "Reading the Store…" : "Nothing stored yet."}</div>`}</div>`;
    }
  }
  function render() {
    const W = v.W;
    if (!W) return;
    if (PROJECT) { drawIde(root, W); noticeNodes(W); return; }
    trackLeaving(W);
    fresh = W.seq === drawnSeq ? -1 : W.seq;
    drawnSeq = W.seq;
    const work = layout.work;
    const keepScroll = [".ftree", ".fview", ".floor"].map((sel) => { const el = work.querySelector(sel); return [sel, el ? el.scrollTop : 0]; });
    if (v.active !== "main" && !W.branches[v.active]) v.active = "main";
    renderTabs();
    if (layout.cols) { layout.cols.dataset.panes = shownPanes(); renderSwap(); } // before measuring: they decide History's box
    const showHist = shownPanes() !== "work", showWork = shownPanes() !== "history";
    if (layout.hist) { if (showHist) drawIde(layout.hist, W); else layout.hist.innerHTML = ""; }
    // the preview's layout keeps History inside the work area
    const inWork = !layout.hist && showHist ? `<section class="panel hist" aria-label="History"></section>` : "";
    work.className = "work " + (v.active === "main" ? "mainview" : "branchview") + (layout.hist ? "" : showHist && showWork ? " withhist" : "");
    work.innerHTML = inWork + (showWork || layout.hist ? (v.active === "main" ? mainView() : branchView(v.active)) : "");
    if (inWork) drawIde(work.querySelector(":scope > .panel.hist"), W);
    noticeNodes(W);
    // terminals follow their newest line; the Branch cards keep their place
    for (const el of work.querySelectorAll(".tbody")) el.scrollTop = el.scrollHeight;
    for (const [sel, top] of keepScroll) { const el = work.querySelector(sel); if (el) el.scrollTop = top; }
    if (sbLit) { const id = sbLit; sbLit = null; lightSandbox(id); } // the redraw dropped the highlight
    if (sbPulse) {
      // its Branch cards, or its chip in the foot when nothing is mounted
      const chips = [...work.querySelectorAll(`.sbc[data-sbid="${CSS.escape(sbPulse)}"]`)];
      sbPulse = null;
      for (const el of new Set(chips.map((c) => c.closest(".bcard") || c))) { el.classList.add("pulse"); el.scrollIntoView({ block: "nearest" }); }
    }
  }

  // ---------------------------------------------------------------- the call that just happened
  // Heroes do not walk from window to window: each stands still in its card
  // rows, chips, lines and terminal heads, and bobs while it works, as on the
  // website. A call shows as a bubble on the window it ran in and, when it
  // made a node, a block flying from there into the tree.
  function hostOf(n) {
    const l = where(n), key = X.locKey(l);
    return (key && q(`[data-loc="${CSS.escape(key)}"]`)) || (l && l.branch && layout.tabs ? layout.tabs.querySelector(`[data-tab="${CSS.escape(l.branch)}"]`) : null);
  }
  function bubbleOn(host, text, cls) {
    const r = host.getBoundingClientRect(), base = overlay.getBoundingClientRect(), b = document.createElement("div");
    b.className = "bubble " + (cls || ""); b.textContent = text;
    b.style.left = Math.min(r.right - base.left - 70, r.left - base.left + r.width / 2) + "px"; b.style.top = r.top - base.top + Math.min(40, r.height / 2) + "px";
    overlay.appendChild(b); setTimeout(() => b.remove(), 2000);
  }
  function flyBlock(host, nodeId, color) {
    const target = q(`[data-node="${CSS.escape(nodeId)}"]`);
    if (!target) return;
    const a = host.getBoundingClientRect(), z = target.getBoundingClientRect(), base = overlay.getBoundingClientRect(), b = document.createElement("div");
    const x0 = a.left - base.left + 16, y0 = a.top - base.top + 16;
    b.className = "block"; b.style.background = color; b.style.left = x0 + "px"; b.style.top = y0 + "px";
    overlay.appendChild(b);
    requestAnimationFrame(() => requestAnimationFrame(() => { b.style.transform = `translate(${z.left - base.left + z.width / 2 - x0 - 6}px,${z.top - base.top + z.height / 2 - y0 - 6}px) scale(.7)`; b.style.opacity = "0"; }));
    setTimeout(() => b.remove(), 900);
  }
  // A node that appears or is updated in History gets a visit: the figure of
  // the agent that made it pops up on it, in the pose of its mood, then goes.
  // A redraw that brings more than a few new nodes at once (a seek, another
  // project) is a jump, not an update, and brings no one.
  let shownNodes = null, freshNodes = [];
  function noticeNodes(W) {
    const ids = Object.keys(W.nodes), before = shownNodes;
    shownNodes = new Set(ids);
    if (!before) return;
    const added = ids.filter((id) => !before.has(id) && W.nodes[id].by);
    if (!added.length || added.length > 3) return;
    freshNodes = added;
    requestAnimationFrame(() => { for (const id of freshNodes) visitNode(W.nodes[id].by, id, nodeMood(W.nodes[id])); freshNodes = []; });
  }
  function visitNode(agent, id, mood) {
    const hero = agent && AV.heroes[avatar(agent).av], sel = `svg.tree [data-node="${CSS.escape(id)}"]`;
    if (!hero || !q(sel)) return;
    const el = document.createElement("span");
    el.className = "visit";
    el.innerHTML = `<span class="av" style="--ac:${avatar(agent).color};${figureStyle(hero, mood)}"></span>`;
    el.title = agent;
    // it stands on its node while the tree grows, scrolls or zooms under it: each frame finds the node again
    // (a redraw replaces it) and hides the figure while the node is out of its panel
    const end = performance.now() + 2000;
    const follow = () => {
      const target = q(sel);
      if (!target || performance.now() > end || (el.dataset.on && !el.isConnected)) { el.remove(); return; }
      const r = target.getBoundingClientRect(), box = (target.closest(".panel") || root).getBoundingClientRect(), base = overlay.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      el.style.visibility = !r.width || x < box.left || x > box.right || y < box.top + 24 || y > box.bottom ? "hidden" : "";
      el.style.left = x - base.left + "px"; el.style.top = r.top - base.top + "px";
      if (!el.dataset.on) { el.dataset.on = "1"; overlay.appendChild(el); }
      requestAnimationFrame(follow);
    };
    follow();
  }

  /** The call that just happened, by `agent`: its bubble and, when it made a node, a block flying there. */
  function animate(agent) {
    const W = v.W;
    if (!W || !W.last || agent === "dsh" || PROJECT) return;
    const mood = MOOD[agent] = moodOf(W.last), maid = root.dataset.skin === "maids";
    const host = hostOf(agent), id = W.last.node;
    // the call's node, new or updated, gets its maker's visit in the call's mood, when the block lands
    if (id && W.nodes[id]) {
      freshNodes = freshNodes.filter((f) => f !== id);
      const by = W.attrib[id] || agent;
      setTimeout(() => visitNode(by, id, by === agent ? mood : nodeMood(W.nodes[id])), host ? 500 : 0);
    }
    if (!host) return;
    const b = maid ? maidBubble(bubbleOf(W.last), mood) : bubbleOf(W.last);
    if (b) bubbleOn(host, b[0], b[1]);
    if (id && W.nodes[id]) flyBlock(host, id, getComputedStyle(root).getPropertyValue(W.nodes[id].branch ? W.branches[W.nodes[id].branch].color : "--trunk").trim());
    // the maids: sparkles or hearts where the node landed (after the block's flight), a sweat drop on the window that failed
    if (maid) {
      const at = (mood === "oops" || mood === "fail") ? host : id && q(`[data-node="${CSS.escape(id)}"]`);
      if (at) setTimeout(() => { const r = at.getBoundingClientRect(), base = overlay.getBoundingClientRect(); maidBurst(overlay, r.left - base.left + r.width / 2, r.top - base.top + (at === host ? 16 : r.height / 2), mood); }, at === host ? 0 : 600);
    }
  }

  // ---------------------------------------------------------------- events
  const setFollow = (on) => {
    v.follow = on;
    if (layout.follow) { layout.follow.classList.toggle("on", on); layout.follow.setAttribute("aria-pressed", String(on)); }
    if (o.onFollow) o.onFollow(on);
  };
  const openTab = (tab) => {
    if (prefs.pane === "history") { prefs.pane = "work"; savePrefs(); } // a tab is a place in Work
    v.active = tab; setFollow(false); closeMenu(); render();
  };
  const onTabs = (e) => {
    closeMenu();
    const pin = e.target.closest("[data-pin]");
    if (pin) { const b = pin.dataset.pin; pinned[b] = !pinned[b]; e.stopPropagation(); render(); return; }
    const more = e.target.closest("[data-more]");
    if (more) { moreMenu(more); e.stopPropagation(); return; }
    const t = e.target.closest("[data-tab]");
    if (t) openTab(t.dataset.tab);
  };
  // Sandboxes: open a Workspace's Branch at its pane, or show a pane's Sandbox on main.
  const onSandbox = (e) => {
    const t = e.target.closest && e.target.closest("[data-dws], [data-sbchip]");
    if (!t) return false;
    if (t.dataset.sbchip) { v.active = "main"; setFollow(false); sbPulse = t.dataset.sbchip; render(); return true; }
    const k = t.dataset.dws, w = v.W.ws[k] || null;
    if (!w) return true;
    v.active = w.branch; setFollow(false); focusPane = k; render(); focusPane = null;
    q(`[data-loc="ws:${CSS.escape(k)}"]`)?.scrollIntoView({ block: "nearest" });
    return true;
  };
  const onClick = (e) => {
    if (!v.W) return;
    {
      const t = e.target.closest(".ide-tabs [data-ide]");
      if (e.target.closest(".ide-tabs [data-ideside]")) { prefs.sideHidden = !prefs.sideHidden; savePrefs(); hist.toNow(); render(); return; }
      if (t) { if (t.dataset.ide === "history" && v.ide !== "history") hist.toNow(); v.ide = t.dataset.ide; closeMenu(); render(); return; }
      if (e.target.closest("[data-ftree][data-ftype='file'], [data-fopen]")) v.ide = "file";
      // a node picked in History holds the files there: following the acting agent would move them
      if (!PROJECT && e.target.closest("svg.tree [data-node], [data-fblame]")) setFollow(false);
    }
    if (hist.click(e)) return;
    if (layout.tabs && layout.tabs.contains(e.target)) return onTabs(e);
    if (layout.follow && layout.follow.contains(e.target)) { setFollow(!v.follow); if (v.follow && o.onFollowOn) o.onFollowOn(); return; }
    if (onSandbox(e)) return;
    const sd = e.target.closest("[data-sdk]");
    if (sd) { const k = sd.dataset.sdk; OPEN_SDK.has(k) ? OPEN_SDK.delete(k) : OPEN_SDK.add(k); render(); return; }
    if (files.click(e)) return;
    const ro = e.target.closest("[data-roster]");
    if (ro) { rosterMenu(ro); return; }
    const mo = e.target.closest("[data-more]");
    if (mo) { moreMenu(mo); return; }
    const sw = e.target.closest("button[data-swap]");
    if (sw) {
      prefs.pane = sw.dataset.swap;
      savePrefs(); hist.toNow(); render(); return;
    }
    const op = e.target.closest("[data-open]");
    if (op) openTab(op.dataset.open);
    else if (!e.target.closest("[data-more]") && !e.target.closest(".menu")) closeMenu();
  };
  // the Sandbox card opens toward the side with room: rightward when the count sits near the box's left edge
  const aimPop = (e) => {
    const sum = e.target.closest && e.target.closest(".sbsum");
    if (sum) sum.classList.toggle("lefty", sum.getBoundingClientRect().right < 340);
  };
  const onOver = (e) => {
    aimPop(e);
    const t = e.target.closest && e.target.closest("[data-sbhl]");
    lightSandbox(t ? t.dataset.sbhl : null);
    hist.over(e);
  };
  // picking a point or a compare in Files pins the view: following the acting agent would switch the tab away
  const onChange = (e) => { if (v.follow && e.target.closest && e.target.closest("[data-fat], [data-fbasesel]")) setFollow(false); files.change(e); };
  // the tree is drawn for its box: a resized box redraws it
  const place = () => {
    if (hist.resized()) render();
  };
  root.addEventListener("click", onClick);
  root.addEventListener("mouseover", onOver);
  root.addEventListener("focusin", aimPop);
  root.addEventListener("mouseout", hist.out);
  root.addEventListener("change", onChange);
  addEventListener("resize", place);
  // narrow layouts scroll a column: avatars stay with their hosts
  root.addEventListener("scroll", place, { capture: true, passive: true });
  root.addEventListener("scroll", hist.scroll, { capture: true, passive: true });
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
  if (resize) resize.observe(root);

  return {
    get W() { return v.W; },
    set W(W) { v.W = W; },
    get active() { return v.active; },
    set active(tab) { v.active = tab; },
    get follow() { return v.follow; },
    set follow(on) { setFollow(on); },
    /** Locations to highlight and agents acting in the current step. */
    set lastLoc(loc) { v.lastLoc = loc; },
    set acting(names) { v.acting = new Set(names); },
    /** Where the view's data comes from: shown in the preview's own note element, when it has one. */
    set note(text) {
      v.note = text || "";
      if (layout.note) layout.note.textContent = v.note;
    },
    /** Shows History or Files in the left panel for a tab. */
    setRight(tab, mode) { v.rightMode[tab] = mode; v.ide = mode === "files" ? "file" : mode === "history" ? "history" : v.ide; },
    /** A project's tab: "file", "history", "storage" or "sandboxes" (when the page gives engine.sandboxes). */
    get ide() { return v.ide; },
    set ide(tab) { v.ide = tab; render(); },
    avatar, render, animate, files,
    dispose() {
      clearTimeout(leaveTimer);
      hist.dispose();
      root.removeEventListener("click", onClick);
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseout", hist.out);
      root.removeEventListener("change", onChange);
      removeEventListener("resize", place);
      root.removeEventListener("scroll", place, { capture: true });
      root.removeEventListener("scroll", hist.scroll, { capture: true });
      if (resize) resize.disconnect();
      overlay.remove();
    },
  };
}
