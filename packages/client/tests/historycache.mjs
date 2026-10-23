// The page's kept History (src/client/historyCache.ts): a kept History is
// checked with `since` and kept while the Host answers unchanged; one read per
// project at a time; the most recently read projects are kept.
//   node packages/client/tests/historycache.mjs
import assert from "node:assert/strict";
import { createHistoryCache } from "../src/client/historyCache.ts";

const asked = [];
let answers = {};
const read = async (name, since) => {
  asked.push([name, since]);
  const answer = answers[name];
  return since && since === answer.version ? { kind: "unchanged", version: since } : answer;
};
const cache = createHistoryCache(read, 2);

// nothing kept before the first read; the first read asks without since
answers = { a: { s: 1, version: "a1" } };
assert.equal(cache.kept("a"), undefined);
const first = await cache.read("a");
assert.deepEqual([first, cache.kept("a"), asked], [answers.a, answers.a, [["a", undefined]]]);

// unchanged: the kept object itself, asked with since
const again = await cache.read("a");
assert.equal(again, first);
assert.deepEqual(asked.at(-1), ["a", "a1"]);

// changed: the new History replaces the kept one
answers = { a: { s: 2, version: "a2" } };
const moved = await cache.read("a");
assert.deepEqual([moved.s, cache.kept("a").version], [2, "a2"]);

// one read per project at a time
asked.length = 0;
const [x, y] = await Promise.all([cache.read("a"), cache.read("a")]);
assert.deepEqual([x === y, asked.length], [true, 1]);

// an answer without a version is not kept
answers.b = { s: 3 };
await cache.read("b");
assert.equal(cache.kept("b"), undefined);

// the most recently read projects are kept; forget drops one
answers.b = { s: 3, version: "b1" };
answers.c = { s: 4, version: "c1" };
await cache.read("b");
await cache.read("c");
assert.deepEqual([cache.kept("a"), cache.kept("b")?.version, cache.kept("c")?.version], [undefined, "b1", "c1"]);
cache.forget("b");
assert.equal(cache.kept("b"), undefined);

// a failed read keeps what was kept and leaves no read running
const failing = createHistoryCache(async (name, since) => { if (since) throw new Error("down"); return { s: 5, version: "d1" }; });
const held = await failing.read("d");
await assert.rejects(failing.read("d"), /down/);
assert.equal(failing.kept("d"), held);
console.log("historycache: ok");
