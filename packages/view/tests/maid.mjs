// The sharky maid skin's voice (skins/maids/voice.js) and moods (cast.js): a call's bubble
// keeps its words and gains a face, and a sheet hero's figure is the frame of its mood. Usage: node tests/maid.mjs
import assert from "node:assert/strict";
import { figureStyle, moodOf, nodeMood } from "../src/cast.js";
import { maidAvatars } from "../src/skins/maids/cast.js";
import { MAID_CSS } from "../src/skins/maids/style.js";
import { maidBubble } from "../src/skins/maids/voice.js";

const call = (name, o) => ({ call: name, o: { ok: true, result: {}, ...o } });
assert.equal(moodOf(call("sandbox.commit", { code: "Committed" })), "win");
assert.equal(moodOf(call("branch.merge", { code: "Merged" })), "merge");
assert.equal(moodOf(call("branch.merge", { ok: false, code: "Conflict" })), "oops");
assert.equal(moodOf(call("sandbox.exec", { code: "Done", result: { exitCode: 2 } })), "fail");
assert.equal(moodOf(call("fs.read", { code: "Read" })), "read");
assert.equal(moodOf(call("sandbox.exec", { code: "Done", result: { exitCode: 0 } })), "work");

// a node's own mood, for a visit no call explains: a Commit, a merge, a Layer, a fork
assert.equal(nodeMood({ kind: "commit", parents: ["C1"] }), "win");
assert.equal(nodeMood({ kind: "commit", parents: ["C1", "C4"] }), "merge");
assert.equal(nodeMood({ kind: "commit", parents: ["C1", null] }), "win");
assert.equal(nodeMood({ kind: "layer", parents: ["L0", "C2"] }), "serve");
assert.equal(nodeMood({ kind: "fork", parents: ["L1"] }), "move");

// the words stay; the face follows the mood; no bubble stays no bubble
assert.deepEqual(maidBubble(["C3", "good"], "win"), ["C3 (๑•̀ㅂ•́)و✧", "good"]);
assert.deepEqual(maidBubble(["Conflict!", "bad"], "oops"), ["Conflict! Σ(°△°|||)", "bad"]);
assert.equal(maidBubble(null, "win"), null);

// a sheet's frame: the mood's pose, the first one the sheet has
const maid = {
  src: "m.png",
  poses: ["idle", "run", "laptop", "read", "cheer", "heart", "sleep", "wave", "serve_tea", "arms_open"],
};
assert.match(figureStyle(maid, "win"), / 44\.444% 0 \/ 1000% 100%/);
assert.match(figureStyle(maid, "sleep"), / 66\.667% 0 /);
assert.match(figureStyle({ src: "h.png" }, "win"), /^background-image:url\(h\.png\)$/);

// the cast: Ellen leads with her expressions; each maid's head is its place in the strip
const cast = maidAvatars((n) => `${n}.png`);
assert.equal(cast.main, "ellen_joe");
assert.equal(cast.heroes.ellen_joe.poses[0], "happy");
assert.deepEqual(cast.heroes["3"].head, { src: "heads.png", index: 2, count: 12 });
assert.equal(cast.heroes["13"].src, "13.png");

// everything the skin draws is scoped to it, but its burst animation
for (const rule of MAID_CSS.split("\n").filter(
  (l) => /^[.@]/.test(l.trim()) && !/^\.lfs \.maidfx|^@keyframes|^@media/.test(l.trim()),
))
  assert.match(rule, /data-skin="maids"/, rule);
console.log("maid: ok");
