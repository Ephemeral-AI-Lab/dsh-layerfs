// Files, as History draws them (view.js drawIde): the tree at one point in
// the sidebar, and the open file in the File tab (File | Blame, and History
// where the trees are in memory). The point is a tab's Branch (or main) at its
// latest head, or a node picked in History; the parent is kept as the base,
// which marks what changed in the tree. Reads go through the files helpers
// (simulation_engine/files.js) on the engine state, so they work on any engine
// that has trees. An engine with `files` (filesource.js, a dsh project) holds
// no trees: a folder is listed when it is opened and a file is read a window
// at a time when it is shown, so Files cost what is on screen whatever the
// project's size.
import { iconOf } from "./fileicons.js";
import { highlightLines } from "./highlight.js";
import { esc, fmtBytes, ratio } from "./util.js";

const COLLAPSE = ["/node_modules", "/.git", "/.next"];
const INODE_BYTES = 73; // one inode value row; directory entries and pooling ignored
const bytesOf = (t) => new TextEncoder().encode(t || "").length;
// a file's lines, coloured by its language (highlight.js) when it has one
const codeLines = (text, path, first = 1) => {
  const lit = path ? highlightLines(text, path) : null;
  return text
    .split("\n")
    .map(
      (t, i) =>
        `<div class="cl"><span class="no">${i + first}</span><span class="tx">${(lit ? lit[i] : esc(t)) || " "}</span></div>`,
    )
    .join("");
};
const CHEV = (open) =>
  `<svg class="chev${open ? " open" : ""}" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// indent guides: one faint rule per folder level
const indent = (depth) => (depth ? `<span class="ind" style="width:${depth * 14}px"></span>` : "");

/**
 * @param {object} v the view: W, FM (files helpers), lineDiff, live,
 *   rightMode, active, colorOf(agent), render()
 */
export function createFiles(v) {
  const FILES = {};
  const W = () => v.W,
    FM = v.FM;
  const laneColor = (b) =>
    !b || b === "main" ? "var(--purple)" : W().branches[b] ? `var(${W().branches[b].color})` : "var(--text-3)";
  const defaultBase = (tab) => (tab === "main" ? "" : "fork:" + tab);
  // list: "changes" (grouped, against the base) or "all" (the tree); path: the
  // open file (the file page) or null (the list); wide: the column takes half the window.
  const filesOf = (tab) =>
    (FILES[tab] ||= {
      at: "latest",
      base: defaultBase(tab),
      path: null,
      toggled: [],
      mode: "view",
      list: "changes",
      sdk: false,
      wide: false,
    });
  const subjectOf = (tab, p) => (p.at === "latest" ? tab : p.at);
  const SRC = () => W().engine.files || null;
  // a ref's saved node and its real id, what the Host reads by
  const savedOf = (ref) => {
    const r = ref ? FM.resolveRef(W().engine, ref) : null,
      real = r && r.node ? W().engine.m?.toReal.get(r.node) : null;
    return real ? { node: r.node, real } : null;
  };
  // path -> "A" | "M" | "D", each path's type and folder roll-ups, from the changed paths read so far
  function lazyChanges(sub, base) {
    const c = SRC().changes(base.real, sub.real),
      files = {},
      types = {},
      dirs = {};
    for (const it of c.items) {
      if (it.type === "dir" && it.kind === "Modified") continue;
      files[it.path] = it.kind === "Added" ? "A" : it.kind === "Removed" ? "D" : "M";
      types[it.path] = it.type;
      for (let d = it.path.slice(0, it.path.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/")))
        dirs[d] = (dirs[d] || 0) + 1;
    }
    return { files, types, dirs, more: c.more, loading: c.loading, error: c.error };
  }
  function pointLabel(ref) {
    if (!ref) return "nothing";
    if (ref === "main" || W().branches[ref]) return `${ref} · latest`;
    if (ref.startsWith("fork:")) return `${ref.slice(5)} · fork point`;
    const n = W().nodes[ref];
    return n ? `${n.branch || "main"} · ${ref}` : ref;
  }
  const dirOpen = (p, path) => (COLLAPSE.includes(path) ? p.toggled.includes(path) : !p.toggled.includes(path));
  function treeHtml(p, subj, base, ch, dir, depth, flash) {
    return FM.listBoth(subj, base, dir)
      .map((e) => {
        const open = e.type === "dir" && dirOpen(p, e.path),
          k = ch && ch.files[e.path],
          roll = ch && !k && ch.dirs[e.path];
        const row = `<div class="frow${e.type === "dir" ? " dir" : ""}${e.path === p.path ? " sel" : ""}${e.gone ? " gone" : ""}${flash.has(e.path) ? " flash" : ""}" data-ftree="${esc(e.path)}" data-ftype="${e.type}" title="${esc(e.path)}">
        ${indent(depth)}<span class="car">${e.type === "dir" ? CHEV(open) : ""}</span>${iconOf(e.name, e.type, open)}<span class="nm">${esc(e.name)}</span>${k ? `<span class="fb ${k}">${k}</span>` : roll ? `<span class="fr" title="changed entries inside">${roll}</span>` : ""}</div>`;
        return row + (open ? treeHtml(p, subj, base, ch, e.path, depth + 1, flash) : "");
      })
      .join("");
  }
  // one folder's loaded pages, folders first; an open folder is listed below its row
  function lazyTreeHtml(p, sub, ch, dir, depth, flash) {
    const l = SRC().list(sub.real, dir),
      isDir = (e) => e.type === "dir";
    const items = [...l.items].sort((a, b) => (isDir(a) === isDir(b) ? 0 : isDir(a) ? -1 : 1));
    const note = (text, attrs = "") =>
      `<div class="frow note"${attrs}>${indent(depth)}<span class="car"></span>${text}</div>`;
    return (
      items
        .map((e) => {
          const open = isDir(e) && p.toggled.includes(e.path),
            k = ch && ch.files[e.path],
            roll = ch && !k && ch.dirs[e.path];
          return (
            `<div class="frow${isDir(e) ? " dir" : ""}${e.path === p.path ? " sel" : ""}${flash.has(e.path) ? " flash" : ""}" data-ftree="${esc(e.path)}" data-ftype="${e.type}" title="${esc(e.path)}">
        ${indent(depth)}<span class="car">${isDir(e) ? CHEV(open) : ""}</span>${iconOf(e.name, e.type, open)}<span class="nm">${esc(e.name)}</span>${k ? `<span class="fb ${k}">${k}</span>` : roll ? `<span class="fr" title="changed entries inside">${roll}${ch.more ? "+" : ""}</span>` : ""}</div>` +
            (open ? lazyTreeHtml(p, sub, ch, e.path, depth + 1, flash) : "")
          );
        })
        .join("") +
      (l.error
        ? note(esc(l.error.message))
        : l.loading
          ? note("Listing…")
          : l.more
            ? note(
                `Show the next 1,000 of ${esc(dir === "/" ? "/" : dir.slice(dir.lastIndexOf("/") + 1))}`,
                ` data-fmore="${esc(dir)}"`,
              )
            : !items.length && depth === 0
              ? note("No files: this version is empty.")
              : "")
    );
  }
  // A file, one window of fs.read at a time (at most 2000 lines or 48 KiB): p.line is where it starts.
  function lazyViewHtml(ref, p, tab) {
    const r = SRC().read(ref.real, p.path, p.line || 1),
      w = r.value;
    if (r.error) return `<div class="fempty">${esc(r.error.message)}</div>`;
    if (!w) return `<div class="fempty">Reading ${esc(p.path)}…</div>`;
    if (w.binary)
      return `<div class="fempty">A binary file${w.size != null ? ` of ${fmtBytes(w.size)}` : ""}: it has no text to show.</div>`;
    const text = w.text.endsWith("\n") ? w.text.slice(0, -1) : w.text,
      last = w.startLine + text.split("\n").length - 1;
    const nav = (dir, label, on) =>
      `<button class="fseg" data-fwin="${esc(tab)}|${dir}"${on ? "" : " disabled"}>${label}</button>`;
    const bar =
      w.startLine > 1 || w.nextLine != null
        ? `<div class="fmodes">${nav("prev", "‹ Earlier", w.startLine > 1)}<span class="fstat">lines ${w.startLine.toLocaleString()}–${last.toLocaleString()}${w.size != null ? ` of ${fmtBytes(w.size)}` : ""}${w.lineTruncated ? " · a long line is cut short" : ""}</span>${nav("next", "Later ›", w.nextLine != null)}<span class="sp"></span><input class="fline" data-fline="${esc(tab)}" type="number" min="1" step="1" placeholder="Go to line"></div>`
        : "";
    return bar + `<div class="code">${codeLines(text, p.path, w.startLine)}</div>`;
  }
  // Which Commit wrote each line (fs.blame), a window at a time like the file
  function lazyBlameHtml(subject, sub, p, tab) {
    const r = SRC().blame(sub.real, p.path, p.line || 1),
      b = r.value;
    if (r.error) return `<div class="fempty">${esc(r.error.message)}</div>`;
    if (!b) return `<div class="fempty">Reading which Commit wrote each line…</div>`;
    if (!b.lines.length) return `<div class="fempty">${esc(p.path)} has no lines here.</div>`;
    const labelOf = (real) => (real ? (W().engine.m?.toLabel.get(real) ?? real.slice(0, 12)) : "?");
    const text = b.lines.map((ln) => String(ln.text ?? "").replace(/\r?\n$/, "")),
      lit = highlightLines(text.join("\n"), p.path);
    let last = null;
    const rows = b.lines
      .map((ln, i) => {
        const id = labelOf(ln.commit),
          first = id !== last,
          c = W().engine.s.commits[id];
        last = id;
        const color = id.startsWith("L") ? "var(--purple)" : laneColor(c && c.branch),
          attr = W().nodes[id] ? ` data-fblame="${esc(id)}"` : "";
        return `<div class="cl"><span class="bch${first ? "" : " cont"}" style="--bc:${color}"${attr} title="${esc(id)} · ${esc(ln.message || "")}">${first ? esc(id) : ""}</span><span class="no">${ln.n}</span><span class="tx">${(lit ? lit[i] : esc(text[i])) || " "}</span></div>`;
      })
      .join("");
    const nav = (dir, label, on) =>
      `<button class="fseg" data-fwin="${esc(tab)}|${dir}"${on ? "" : " disabled"}>${label}</button>`;
    const first = b.lines[0].n,
      end = b.lines[b.lines.length - 1].n;
    const bar =
      first > 1 || b.nextLine != null
        ? `<div class="fmodes">${nav("prev", "‹ Earlier", first > 1)}<span class="fstat">lines ${first.toLocaleString()}–${end.toLocaleString()}</span>${nav("next", "Later ›", b.nextLine != null)}</div>`
        : "";
    return `<div class="fsum">Blame at <b>${esc(pointLabel(subject))}</b> · product attribution (fs.blame)${b.versions ? ` · ${b.versions} versions compared` : ""}</div>${bar}<div class="code">${rows}</div>`;
  }
  // Per-file revisions, dedupe and compression: sim estimates, or the
  // product's operator.files.stats/history and fs.blame (engine.fileReport).
  // A fork point is sent as the node it was forked from.
  const reportRef = (subject) =>
    subject.startsWith("fork:") ? (FM.resolveRef(W().engine, subject) || {}).node || subject : subject;
  function fileStats(subject, path) {
    if (v.live) {
      const f = W().engine.fileReport(reportRef(subject), path),
        k = { added: "A", modified: "M", deleted: "D", removed: "D" };
      return { ...f, rows: f.rows.map((r) => ({ ...r, change: k[r.change] || r.change })) };
    }
    const revs = FM.history(W().engine, subject, path),
      seen = new Set();
    let logical = 0,
      unique = 0,
      stored = 0,
      pending = false;
    const rows = [...revs]
      .reverse()
      .map((r) => {
        if (r.content == null) return { ...r, size: 0, added: 0, stored: 0 };
        const size = bytesOf(r.content),
          fresh = !seen.has(r.content);
        logical += size;
        let z = 0;
        if (fresh) {
          seen.add(r.content);
          unique += size;
          z = W().engine.storedSize(r.content);
          if (z == null) {
            pending = true;
            z = size;
          }
          stored += z;
        }
        return { ...r, size, added: fresh ? size : 0, stored: fresh ? z : 0 };
      })
      .reverse();
    return { rows, revisions: revs.length, logical, unique, stored, pending, metadata: revs.length * INODE_BYTES };
  }
  function fileStatsHtml(subject, p, sv) {
    const e = sv.tree[p.path];
    if (!e || e.type !== "file") return "";
    const f = fileStats(subject, p.path),
      cur = v.live ? f.size : e ? bytesOf(e.content) : null,
      size = cur == null ? (e ? "…" : "deleted here") : fmtBytes(cur);
    // one line; the full numbers are in the tooltip
    const tip =
      `${f.revisions ?? "?"} revisions (saved versions where this file changed) · current ${size} · history ${fmtBytes(f.logical)} logical · unique ${fmtBytes(f.unique)} (dedupe ${ratio(f.logical, f.unique)})` +
      (v.live
        ? ` · ${f.error || "product: operator.files.stats and files.history; physical per-file attribution not reported"}`
        : ` · stored ≈ ${fmtBytes(f.stored)} (compression ${ratio(f.unique, f.stored)}, sim: deflate as a stand-in for zstd) · metadata ≈ ${fmtBytes(f.metadata)}`);
    return `<span class="fstat" title="${esc(tip)}"><b>${f.revisions ?? "…"}</b> rev · ${size}${v.live ? "" : ` · ${ratio(f.unique, f.stored)}`}${f.pending ? " · …" : ""}</span>`;
  }
  function fileHistoryHtml(subject, path) {
    const f = fileStats(subject, path);
    if (v.live && f.pending) return `<div class="fempty">Loading the file's history…</div>`;
    if (!f.rows.length)
      return `<div class="fempty">${esc(f.error || (f.replay ? "File history is not in the trace." : `${path} has no saved versions behind ${pointLabel(subject)}.`))}</div>`;
    const rows = f.rows
      .map(
        (
          r,
        ) => `<tr><td><span class="bch" style="--bc:${r.node.kind === "layer" ? "var(--purple)" : laneColor(r.node.branch)}" data-fblame="${r.node.id}" title="${esc(r.node.id)} · click to diff with its parent">${r.node.id}</span></td><td><span class="fb ${r.change}">${r.change}</span></td>
      <td class="n">${r.content == null ? "–" : fmtBytes(r.size)}</td><td class="n${r.added ? "" : " zero"}">${r.content == null ? "–" : r.added == null ? "not reported" : r.added ? "+" + fmtBytes(r.added) : "reused"}</td>${v.live ? "" : `<td class="n${r.stored ? "" : " zero"}">${r.stored ? fmtBytes(r.stored) : "–"}</td>`}</tr>`,
      )
      .join("");
    return `<div class="fsum">${f.revisions} revision${f.revisions === 1 ? "" : "s"} behind <b>${esc(pointLabel(subject))}</b>, newest first · new = bytes this version added (an identical earlier version is reused)${f.hasMore ? " · first 50 shown" : ""}</div>
      <table class="frev"><tr><th>version</th><th></th><th class="n">size</th><th class="n">new</th>${v.live ? "" : '<th class="n">stored ≈</th>'}</tr>${rows}</table>`;
  }
  function viewHtml(subject, p, sv) {
    const se = sv.tree[p.path];
    if (p.mode === "view") {
      if (!se)
        return `<div class="fempty">${esc(p.path)} does not exist at ${esc(pointLabel(subject))}${be ? " (deleted; switch to Diff to see what was removed)" : ""}.</div>`;
      return se.type === "file"
        ? se.content == null
          ? `<div class="fempty">${esc(se.note || "Content not loaded.")}</div>`
          : `<div class="code">${codeLines(se.content, p.path)}</div>`
        : `<div class="fempty">${esc(p.path)} is a folder.</div>`;
    }
    if (p.mode === "blame") {
      let b;
      if (v.live) {
        // The product's fs.blame: each line names the Commit or Layer it came from.
        const report = fileStats(subject, p.path);
        if (!report.blame)
          return `<div class="fempty">${esc(report.error || (report.replay ? "Blame is not in the trace." : "Loading attributed lines…"))}</div>`;
        b = {
          ...report.blame,
          versions: report.revisions,
          lines: report.blame.lines.map((l) => ({
            ...l,
            origin: {
              id: l.commit,
              kind: l.commit.startsWith("L") ? "layer" : "commit",
              branch: (W().engine.s.commits[l.commit] || {}).branch,
            },
          })),
        };
      } else b = FM.blame(W().engine, subject, p.path);
      if (!b) return `<div class="fempty">${esc(p.path)} does not exist at ${esc(pointLabel(subject))}.</div>`;
      let last = null;
      const lit = highlightLines(b.lines.map((ln) => ln.text).join("\n"), p.path);
      const rows = b.lines
        .map((ln, i) => {
          const o = ln.origin,
            first = o.id !== last;
          last = o.id;
          return `<div class="cl"><span class="bch${first ? "" : " cont"}" style="--bc:${o.kind === "layer" ? "var(--purple)" : laneColor(o.branch)}" data-fblame="${o.id}" title="${esc(o.id)} · ${esc(W().attrib[o.id] || "")} · click to diff with its parent">${first ? o.id : ""}</span><span class="no">${ln.n}</span><span class="tx">${(lit ? lit[i] : esc(ln.text)) || " "}</span></div>`;
        })
        .join("");
      return `<div class="fsum">Blame at <b>${esc(pointLabel(subject))}</b> · ${v.live ? "product attribution (fs.blame)" : `composed from ${b.versions} saved versions`}</div><div class="code">${rows}</div>`;
    }
    return fileHistoryHtml(subject, p.path);
  }
  // One file, as the File tab shows it: File | Blame, then the file or its blame.
  function lazyFilePage(tab, p, subject, sub) {
    const seg = (m, label) =>
      `<button class="fseg${p.mode === m ? " on" : ""}" data-fmode="${esc(tab)}|${m}">${label}</button>`;
    // a saved id's file history has no read yet: History shows only where the full trees are
    if (p.mode === "history") p.mode = "view";
    const body = p.mode === "blame" ? lazyBlameHtml(subject, sub, p, tab) : lazyViewHtml(sub, p, tab);
    return `<div class="fmodes"><span class="segs">${seg("view", "File")}${seg("blame", "Blame")}</span></div>
      <div class="fbody"><div class="fview">${body}</div></div>`;
  }
  // One file in memory (the sim's full trees): File | Blame | History and its
  // one-line summary, then the file itself.
  function filePage(tab, p, subject, sv) {
    const seg = (m, label) =>
      `<button class="fseg${p.mode === m ? " on" : ""}" data-fmode="${esc(tab)}|${m}">${label}</button>`;
    return `<div class="fmodes"><span class="segs">${seg("view", "File")}${seg("blame", "Blame")}${seg("history", "History")}</span><span class="sp"></span>${fileStatsHtml(subject, p, sv)}</div>
      <div class="fbody"><div class="fview">${viewHtml(subject, p, sv)}</div></div>`;
  }
  // A project page splits Files like an editor: the tree at the picked point
  // (and its compare) in the sidebar, the open file in its own tab.
  /** The subject and its compare, saved or in memory: { subject, sub, base, ch, nFiles } or null. */
  function pointOf(tab, p) {
    if (p.at !== "latest" && !W().nodes[p.at] && !p.at.startsWith("fork:")) p.at = "latest";
    const subject = subjectOf(tab, p);
    if (SRC()) {
      const sub = savedOf(subject);
      if (!sub) return null;
      const base = p.base ? savedOf(p.base) : null,
        ch = base ? lazyChanges(sub, base) : null;
      return {
        subject,
        sub,
        base,
        ch,
        nFiles: ch
          ? `${Object.keys(ch.files).filter((path) => ch.types[path] === "file").length}${ch.more ? "+" : ""}`
          : null,
      };
    }
    const sv = FM.resolveRef(W().engine, subject);
    if (!sv) return null;
    const bv = p.base ? FM.resolveRef(W().engine, p.base) : null,
      ch = bv ? FM.changeMap(sv.tree, bv.tree) : null;
    return {
      subject,
      sv,
      bv,
      ch,
      nFiles: ch
        ? String(Object.keys(ch.files).filter((path) => (sv.tree[path] || bv.tree[path] || {}).type === "file").length)
        : null,
    };
  }
  function sideHtml(tab) {
    const p = filesOf(tab),
      pt = pointOf(tab, p),
      flash = p.at === "latest" ? W().flash[tab] || new Set() : new Set();
    // the point is picked in History (a node): the sidebar names its Branch over the tree
    if (!pt) return `<div class="fempty">Nothing to show yet.</div>`;
    const tree = SRC()
      ? lazyTreeHtml(p, pt.sub, pt.ch, "/", 0, flash)
      : treeHtml(p, pt.sv.tree, pt.bv ? pt.bv.tree : null, pt.ch, "/", 0, flash);
    const n = p.at === "latest" ? null : W().nodes[p.at] || null,
      lane = n ? n.branch || "main" : tab;
    const point = !n
      ? `${tab === "main" ? W().mainHead : W().branches[tab].head.replace("fork:", "fork ")} · latest`
      : n.kind === "fork"
        ? "fork point"
        : n.id;
    const back = n
      ? `<button class="ide-latest" data-idelatest="1" title="Back to ${esc(tab)} at its latest head">latest</button>`
      : "";
    return `<div class="ide-title" title="Pick a node in History to see the files there"><span class="dot" style="background:${laneColor(lane)}"></span><b>${esc(lane)}</b><span class="pt">${esc(point)}</span>${back}</div><div class="ftree">${tree}</div>`;
  }
  // the open file, read or blamed (the tree's badges say what changed since the parent)
  function pageHtml(tab) {
    const p = filesOf(tab),
      pt = pointOf(tab, p);
    if (!pt) return `<div class="fempty">Nothing to show yet.</div>`;
    if (!p.path)
      return `<div class="fempty">Pick a file in the tree: it opens here at ${esc(pointLabel(pt.subject))}.</div>`;
    if (p.mode !== "blame" && p.mode !== "history") p.mode = "view";
    return SRC() ? lazyFilePage(tab, p, pt.subject, pt.sub) : filePage(tab, p, pt.subject, pt.sv);
  }
  const safe = (draw) => (tab) => {
    try {
      return draw(tab);
    } catch (error) {
      console.error("Files could not draw", error);
      return `<div class="fempty">Files could not draw this view: ${esc(error.message)}. Pick another file or point.</div>`;
    }
  };
  // Opening a file shows what changed when it changed, else the file.
  function openFile(p, path) {
    p.line = 1;
    p.starts = [];
    if (SRC()) {
      const sub = savedOf(subjectOf(v.active, p)),
        base = p.base ? savedOf(p.base) : null;
      p.path = path;
      p.mode = "view";
      return;
    }
    const sv = FM.resolveRef(W().engine, subjectOf(v.active, p)),
      bv = p.base ? FM.resolveRef(W().engine, p.base) : null;
    const changed = sv && bv && FM.changeMap(sv.tree, bv.tree).files[path];
    p.path = path;
    p.mode = "view";
  }
  /** Files at any node, compared with its parent (a project page): an open file stays open there. */
  function showAt(tab, id) {
    const p = filesOf(tab),
      n = W().nodes[id];
    if (!n) return;
    p.at = n.kind === "fork" ? "fork:" + n.branch : id;
    p.base = FM.parentRef(W().engine, p.at) || "";
    p.line = 1;
    p.starts = [];
    v.rightMode[tab] = "files";
  }
  // Files controls, and History nodes that open Files at that point.
  function click(e) {
    const at = (sel) => e.target.closest(sel),
      tab = v.active;
    let el;
    if ((el = at("[data-fmode]"))) {
      const [t, m] = el.dataset.fmode.split("|"),
        p = filesOf(t);
      p.mode = m;
      p.line = 1;
      p.starts = [];
      v.render();
      return true;
    }
    if ((el = at("[data-fmore]"))) {
      const p = filesOf(tab),
        sub = savedOf(subjectOf(tab, p));
      if (sub) SRC().moreList(sub.real, el.dataset.fmore);
      v.render();
      return true;
    }
    if ((el = at("[data-fwin]"))) {
      // Later starts where the window ended; Earlier goes back the way it came, else 2000 lines up
      const [t, dir] = el.dataset.fwin.split("|"),
        p = filesOf(t),
        sub = savedOf(subjectOf(t, p));
      const w =
        sub &&
        (p.mode === "blame" ? SRC().blame(sub.real, p.path, p.line || 1) : SRC().read(sub.real, p.path, p.line || 1))
          .value;
      p.starts ||= [];
      if (dir === "next" && w?.nextLine) {
        p.starts.push(p.line || 1);
        p.line = w.nextLine;
      }
      if (dir === "prev") p.line = p.starts.pop() ?? Math.max(1, (p.line || 1) - 2000);
      v.render();
      return true;
    }
    if ((el = at("[data-ftree]"))) {
      const p = filesOf(tab),
        path = el.dataset.ftree;
      if (el.dataset.ftype === "dir") {
        p.toggled = p.toggled.includes(path) ? p.toggled.filter((x) => x !== path) : [...p.toggled, path];
      } else openFile(p, path);
      v.render();
      return true;
    }
    if ((el = at("[data-fblame]"))) {
      showAt(tab, el.dataset.fblame);
      v.render();
      return true;
    }
    if ((el = at(".gview [data-node], svg.tree [data-node]"))) {
      showAt(tab, el.dataset.node);
      v.render();
      return true;
    }
    if ((el = at("[data-idelatest]"))) {
      const p = filesOf(tab);
      p.at = "latest";
      p.base = defaultBase(tab);
      p.line = 1;
      p.starts = [];
      v.render();
      return true;
    }
    return false;
  }
  function change(e) {
    const t = e.target;
    if (t.dataset.fline !== undefined) {
      const p = filesOf(t.dataset.fline),
        n = Math.floor(Number(t.value));
      if (n >= 1) {
        p.starts = [];
        p.line = n;
        v.render();
      }
    }
  }
  return { filesOf, sideHtml: safe(sideHtml), pageHtml: safe(pageHtml), showAt, click, change };
}
