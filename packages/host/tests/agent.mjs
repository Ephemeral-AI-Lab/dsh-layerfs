// The Host's wrappers in an agent's process (src/agent/): the mapping sets
// LAYERFS_<NAME> from DSH_LAYERFS_<NAME> and never overrides a set one; the
// SDK and backend wrappers have their packages' exports; the CLI wrapper runs
// LayerFS's CLI on the project DSH_LAYERFS_PROJECT names.
//   node packages/host/tests/agent.mjs
// Every child process gets only the environment written here. The CLI runs on
// a stand-in binding that records the project its Store opens, so no Store is
// needed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT = fileURLToPath(new URL("../src/agent/", import.meta.url));
const node = (args, env) => spawnSync(process.execPath, args, { encoding: "utf8", env: { PATH: process.env.PATH, ...env }, timeout: 60_000 });
const dir = mkdtempSync(join(tmpdir(), "dsh-layerfs-agent-"));

// the mapping: an unset LAYERFS_X takes DSH_LAYERFS_X; a set one is kept
{
  const script = `await import(${JSON.stringify(join(AGENT, "env.js"))}); console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /LAYERFS_/.test(k)).sort())));`;
  const run = node(["--input-type=module", "-e", script], { DSH_LAYERFS_PROJECT: "shop", DSH_LAYERFS_TRACE_STEP: "r1", DSH_LAYERFS_HOME: "/dsh/home", LAYERFS_HOME: "/own/home" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    DSH_LAYERFS_HOME: "/dsh/home", DSH_LAYERFS_PROJECT: "shop", DSH_LAYERFS_TRACE_STEP: "r1",
    LAYERFS_HOME: "/own/home", LAYERFS_PROJECT: "shop", LAYERFS_TRACE_STEP: "r1",
  });
}

// the SDK and backend wrappers: the same named exports as their packages, the mapping done first
{
  const script = `const [a, w, b, v] = await Promise.all([import("@layerfs/agent"), import(${JSON.stringify(join(AGENT, "sdk.js"))}), import("@layerfs/backend"), import(${JSON.stringify(join(AGENT, "backend.js"))})]);
console.log(JSON.stringify({ same: Object.keys(a).every((k) => a[k] === w[k]) && Object.keys(b).every((k) => b[k] === v[k]), sdk: Object.keys(w).sort(), backend: Object.keys(v).sort(), project: process.env.LAYERFS_PROJECT }));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: join(AGENT, ".."), encoding: "utf8", env: { PATH: process.env.PATH, DSH_LAYERFS_PROJECT: "shop" }, timeout: 60_000 });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.ok(out.same, "the wrappers re-export the packages' own bindings");
  assert.ok(out.sdk.includes("LayerFS") && out.sdk.includes("LayerFSError"), out.sdk.join(" "));
  assert.deepEqual(out.backend, ["LayerFSBackend"]);
  assert.equal(out.project, "shop");
}

// the CLI wrapper: DSH_LAYERFS_PROJECT alone names the project its Store opens; exit codes and stdout are the CLI's
{
  const opened = join(dir, "opened.jsonl"), binding = join(dir, "binding.cjs");
  writeFileSync(binding, `const fs = require("node:fs");
const ok = async () => ({ value: { items: [], hasMore: false } });
module.exports = { call: ok, backendCall: ok, storeOpen: async (args) => { fs.appendFileSync(${JSON.stringify(opened)}, JSON.stringify(args) + "\\n"); return ok(); }, storeClose: ok };`);
  const cli = join(AGENT, "cli.js");
  const env = { DSH_LAYERFS_PROJECT: "wrapped", DSH_LAYERFS_NATIVE: binding, DSH_LAYERFS_STORE_PATH: "/stand-in/store.sqlite", DSH_LAYERFS_HOME: "/stand-in" };
  const run = node([cli, "project", "list_branches"], env);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { items: [], hasMore: false });
  const [args] = readFileSync(opened, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual([args.project, args.home], ["wrapped", "/stand-in"]);
  assert.equal(JSON.stringify(args).includes("/stand-in/store.sqlite"), true, "the Store path comes from DSH_LAYERFS_STORE_PATH");
  // no project: the CLI's own usage refusal (exit 2); help exits 0
  const none = node([cli, "project", "list_branches"], { DSH_LAYERFS_NATIVE: binding });
  assert.equal(none.status, 2, none.stderr);
  assert.match(none.stderr, /no LayerFS project/);
  assert.equal(node([cli, "help"], {}).status, 0);
}
console.log("agent wrappers: ok");
