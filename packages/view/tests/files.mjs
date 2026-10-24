// Files on demand (files.js with filesource.js), as History's sidebar tree and
// File tab draw them: a folder is listed when it is opened, a file is read one
// window at a time, Blame by window, and each of those is one Host read.
// Usage: node tests/files.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as X from "../../model/src/index.js";
import { createFiles } from "../src/files.js";
import { createFilesSource } from "../src/filesource.js";

const require = createRequire(import.meta.url);
const FM = require("../../../sim/simulation_engine/files.js");
const M = require("../../../sim/simulation_engine/model.js");

const L0 = "a".repeat(64),
  C1 = "12" + "1".repeat(64),
  C2 = "12" + "2".repeat(64);
// the Host's answers by kind and query; anything else is a test failure
const HOST = {
  [`list ${C2} / 0`]: {
    items: [
      { name: "src", path: "/src", type: "dir" },
      { name: "big.log", path: "/big.log", type: "file" },
      { name: "a.txt", path: "/a.txt", type: "file" },
    ],
    next: null,
  },
  [`list ${C2} /src 0`]: { items: [{ name: "x.rs", path: "/src/x.rs", type: "file" }], next: 1000 },
  [`list ${C2} /src 1000`]: { items: [{ name: "y.rs", path: "/src/y.rs", type: "file" }], next: null },
  [`read ${C2} /big.log 1`]: { text: "one\ntwo\n", startLine: 1, nextLine: 3, lineTruncated: false, size: 9000 },
  [`read ${C2} /big.log 3`]: { text: "three\n", startLine: 3, nextLine: null, lineTruncated: false, size: 9000 },
  [`read ${C2} /src/x.rs 1`]: { text: "fn x() {}\n", startLine: 1, nextLine: null, lineTruncated: false, size: 10 },
  [`changes ${C1} ${C2} 0`]: {
    items: [
      { path: "/src", kind: "Modified", type: "dir" },
      { path: "/src/x.rs", kind: "Modified", type: "file" },
    ],
    next: null,
  },
  [`blame ${C2} /src/x.rs 1`]: {
    lines: [{ n: 1, text: "fn x() {}", lineTruncated: false, commit: C2, message: "two" }],
    versions: 2,
    nextLine: null,
  },
  [`diff ${C1} ${C2} /src/x.rs`]: {
    kind: "Text",
    hunks: [
      { op: "-", text: "fn x();" },
      { op: "+", text: "fn x() {}" },
    ],
    hunksOmitted: false,
  },
};
const asked = [];
const source = createFilesSource(
  async (kind, q) => {
    const key = [kind, ...Object.values(q)].join(" ");
    asked.push(key);
    if (!(key in HOST)) throw Object.assign(new Error(`unexpected read ${key}`), { code: "test" });
    return HOST[key];
  },
  () => {},
);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// a project: main's Init Layer, a Branch with two Commits
const E = new X.ReplayEngine({ project: "p", files: source });
const end = (method, args, rest) => E.apply({ method, args, ok: true, phase: "end", ...rest });
end("project.init", {}, {});
end("branch.fork", { name: "work", from: "main" }, { branch: "work", base: L0, head: null });
E.addCommit(C1, "work", { via: "fs", message: "one" });
E.addCommit(C2, "work", { via: "fs", message: "two" });
const W = X.derive(X.storyView(E, { lead: "main" }));
const v = { W, FM, lineDiff: M.lineDiff, live: false, rightMode: {}, active: "work", render() {} };
const files = createFiles(v);
const p = files.filesOf("work");
p.base = "";
const click = (attr, value, extra = {}) =>
  files.click({ target: { closest: (sel) => (sel === `[${attr}]` ? { dataset: { ...extra } } : null) } });

// the sidebar's root is one list call; nothing is read
assert.match(files.sideHtml("work"), /Listing…/);
await settle();
let html = files.sideHtml("work");
assert.deepEqual(asked, [`list ${C2} / 0`]);
assert.ok(
  html.indexOf(">src<") < html.indexOf(">big.log<") && html.indexOf(">big.log<") < html.indexOf(">a.txt<"),
  "folders first, then the SDK's order",
);

// opening a folder lists its first page; the next page waits for "show more"
click("data-ftree", "", { ftree: "/src", ftype: "dir" });
files.sideHtml("work");
await settle();
html = files.sideHtml("work");
assert.match(html, />x\.rs</);
assert.match(html, /data-fmore="\/src"/);
click("data-fmore", "", { fmore: "/src" });
files.sideHtml("work");
await settle();
assert.match(files.sideHtml("work"), />y\.rs</);
assert.deepEqual(asked.slice(1), [`list ${C2} /src 0`, `list ${C2} /src 1000`]);

// a file opens in the File tab, read a window at a time; Later reads from where the window ended, Earlier goes back
click("data-ftree", "", { ftree: "/big.log", ftype: "file" });
assert.equal(p.mode, "view");
files.pageHtml("work");
await settle();
html = files.pageHtml("work");
assert.match(html, /lines 1–2 of 9\.00 KB/);
assert.match(html, /<span class="no">2<\/span>/);
assert.doesNotMatch(html, /data-fmode="work\|diff"/, "File and Blame only");
click("data-fwin", "", { fwin: "work|next" });
files.pageHtml("work");
await settle();
html = files.pageHtml("work");
assert.match(html, /<span class="no">3<\/span><span class="tx">three/);
click("data-fwin", "", { fwin: "work|prev" });
assert.match(files.pageHtml("work"), /<span class="no">1<\/span>/);
assert.deepEqual(asked.slice(3), [`read ${C2} /big.log 1`, `read ${C2} /big.log 3`], "a window is read once");

// Blame reads fs.blame by window, naming the Commit; History is not offered without full trees
click("data-ftree", "", { ftree: "/src/x.rs", ftype: "file" });
click("data-fmode", "", { fmode: "work|blame" });
files.pageHtml("work");
await settle();
html = files.pageHtml("work");
assert.match(html, /data-fblame="C2"[^>]*>C2</);
assert.doesNotMatch(html, /data-fmode="work\|history"/);
assert.equal(asked.at(-1), `blame ${C2} /src/x.rs 1`);

// a view that cannot draw says so in its place
const model = v.W;
v.W = null;
assert.match(files.pageHtml("work"), /Files could not draw this view/);
assert.match(files.sideHtml("work"), /Files could not draw this view/);
v.W = model;

// a refusal is shown and not asked again by itself
p.path = null;
p.toggled.push("/gone");
HOST[`list ${C2} / 0`].items.push({ name: "gone", path: "/gone", type: "dir" });
const before = asked.length;
source.list(C2, "/gone");
await settle();
assert.match(files.sideHtml("work"), /unexpected read list/);
files.sideHtml("work");
await settle();
assert.equal(asked.length, before + 1);
console.log("files: ok");
