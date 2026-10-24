#!/usr/bin/env node
// Static check of a scenario folder, without running it: it loads with the
// scenario loader (tags, form and placeholders included), every bash step's
// command parses (bash -n for a cli scenario; node --check of the inline
// script for an sdk one), and every changes file is the JSON array `layerfs
// fs apply` reads and is used. A converted replay (tools/replay/convert.mjs;
// it has a final.json) also has its seed.json checked against the recorded
// one plus the additions convert.mjs declares for it (SEED_ADDITIONS; depot's
// .cargo/config.toml), and nothing else, written out exactly as the plugin does.
//   node tools/replay/check.mjs <scenario> [--repo <layerfs checkout>] [--rev <commit>]
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "../../packages/mock/src/scenario.js";
import { writeSeed } from "../../packages/mock/src/seed.js";
import { SEED_ADDITIONS } from "./convert.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i < 0 ? fallback : argv.splice(i, 2)[1];
};
const repo = resolve(ROOT, opt("--repo", process.env.LAYERFS_SOURCE || "../layerfs"));
const rev = opt("--rev", "0c7d9c47c1^");
const name = argv[0];
const folder = join(ROOT, "scenarios", name ?? "");
const problems = [];

const scenario = loadScenario(folder);
const scratch = mkdtempSync(join(tmpdir(), `check-${name}-`));
const bash = Object.values(scenario.agents)
  .flat()
  .filter((s) => s.kind === "call" && s.call.name === "bash");
const used = new Set();
for (const s of bash) {
  const command = s.call.args.command;
  const r = spawnSync("bash", ["-n"], { input: command, encoding: "utf8" });
  if (r.status !== 0) problems.push(`${s.at}: bash -n: ${r.stderr.trim()}`);
  if (scenario.form === "sdk") {
    const body = command.match(/<<'([A-Z_]+)'\n([\s\S]*)\n\1\n?$/)?.[2] ?? "";
    const file = join(scratch, "step.mjs");
    writeFileSync(file, body);
    const c = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (c.status !== 0) problems.push(`${s.at}: node --check: ${c.stderr.trim().split("\n").slice(0, 5).join(" / ")}`);
  }
  for (const m of command.matchAll(/changes\/([0-9]+(?:-[0-9]+)?\.json)/g)) used.add(m[1]);
  if (/\bsandbox\.(mount|exec|commit|unmount):/.test(JSON.stringify(s.expect ?? [])))
    problems.push(`${s.at}: an old trace name in expect`);
}

const changes = existsSync(join(folder, "changes")) ? readdirSync(join(folder, "changes")) : [];
for (const file of changes) {
  let list;
  try {
    list = JSON.parse(readFileSync(join(folder, "changes", file), "utf8"));
  } catch (error) {
    problems.push(`changes/${file}: ${error.message}`);
    continue;
  }
  const ok =
    Array.isArray(list) &&
    list.length &&
    list.every(
      (c) =>
        (c.op === "write" &&
          typeof c.path === "string" &&
          c.path.startsWith("/") &&
          typeof c.content === "string" &&
          Object.keys(c).length === 3) ||
        (c.op === "mkdir" && typeof c.path === "string" && c.path.startsWith("/") && Object.keys(c).length === 2),
    );
  if (!ok) problems.push(`changes/${file}: not a list of {op: write, path, content} / {op: mkdir, path}`);
  if (!used.has(file)) problems.push(`changes/${file}: no step applies it`);
}
for (const file of used) if (!changes.includes(file)) problems.push(`changes/${file}: applied but missing`);

let entries = 0;
if (existsSync(join(folder, "final.json"))) entries = checkSeed();
rmSync(scratch, { recursive: true, force: true });

/** A replay's seed.json against the recorded one plus its declared additions, written out as the plugin does; answers its entry count. */
function checkSeed() {
  const recorded = execFileSync("git", ["-C", repo, "show", `${rev}:dsh/scenarios/${name}/seed.json`], {
    encoding: "utf8",
  });
  const additions = SEED_ADDITIONS[name] ?? {};
  const seed = JSON.parse(recorded);
  for (const path of Object.keys(additions))
    if (seed.entries[path]) problems.push(`seed.json: the declared addition ${path} is in the recorded seed already`);
  seed.entries = { ...seed.entries, ...additions };
  // the fixture is the scenario's seed.json, as the plugin writes it out (packages/mock/src/seed.js)
  if (!scenario.seed) problems.push("fixture: not a seed file");
  else if (!Object.keys(additions).length) {
    if (readFileSync(scenario.seed, "utf8") !== recorded) problems.push("seed.json: differs from the recorded one");
  } else {
    const ours = JSON.parse(readFileSync(scenario.seed, "utf8"));
    const { entries: ourEntries, ...ourRest } = ours,
      { entries: wantEntries, ...wantRest } = seed;
    if (JSON.stringify(ourRest) !== JSON.stringify(wantRest))
      problems.push("seed.json: its fields differ from the recorded seed's");
    for (const path of new Set([...Object.keys(ourEntries ?? {}), ...Object.keys(wantEntries)])) {
      const a = ourEntries?.[path],
        b = wantEntries[path];
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      problems.push(
        `seed.json ${path}: ${!a ? "missing" : !b ? "neither recorded nor a declared addition" : additions[path] ? "differs from the declared addition" : "differs from the recorded entry"}`,
      );
    }
  }
  const fixture = writeSeed(scenario.seed, mkdtempSync(join(tmpdir(), `replay-${name}-`)));
  const found = new Map();
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry),
        st = lstatSync(path),
        key = `/${relative(fixture, path)}`;
      found.set(key, { st, path });
      if (st.isDirectory()) walk(path);
    }
  })(fixture);
  for (const [path, e] of Object.entries(seed.entries)) {
    const f = found.get(path);
    if (!f) {
      problems.push(`fixture${path}: missing`);
      continue;
    }
    found.delete(path);
    const type = f.st.isDirectory() ? "dir" : f.st.isSymbolicLink() ? "symlink" : "file";
    if (type !== e.type) problems.push(`fixture${path}: a ${type}, the seed has a ${e.type}`);
    if (e.mode !== undefined && type !== "symlink" && (f.st.mode & 0o7777) !== e.mode)
      problems.push(`fixture${path}: mode ${(f.st.mode & 0o7777).toString(8)}, the seed has ${e.mode.toString(8)}`);
    if (type === "file") {
      const want = e.text !== undefined ? Buffer.from(e.text) : Buffer.from(e.base64 ?? "", "base64");
      if (!readFileSync(f.path).equals(want)) problems.push(`fixture${path}: content differs from the seed`);
    }
    if (type === "symlink" && readlinkSync(f.path) !== e.target) problems.push(`fixture${path}: link target differs`);
  }
  for (const path of found.keys()) problems.push(`fixture${path}: not in the seed`);
  rmSync(fixture, { recursive: true, force: true });
  return Object.keys(seed.entries).length;
}

console.log(
  `${name} (${scenario.tags.join(", ")}): ${bash.length} bash steps, ${changes.length} changes files${entries ? `, ${entries} fixture entries` : ""}: ${problems.length ? `${problems.length} problem(s)` : "ok"}`,
);
for (const p of problems) console.log(`  ✕ ${p}`);
process.exitCode = problems.length ? 1 : 0;
