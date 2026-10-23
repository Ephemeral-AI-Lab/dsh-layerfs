#!/usr/bin/env node
// Converts a recorded-run replay of the LayerFS scripted model (shop, depot
// or crew) into the current scenario format (version 3).
//
//   node tools/replay/convert.mjs <shop|depot|crew> [--repo <layerfs checkout>] [--rev <commit>]
//
// The source is the layerfs repository's dsh/scenarios/<name>/ at --rev
// (default 0c7d9c47c1^, the parent of the commit that moved dsh/ out), read
// with git from --repo (default $LAYERFS_SOURCE, else ../layerfs beside this
// repository): scenario.json (format layerfs-mock-scenario v2), seed.json,
// final.json and run/NNN.json, one per recorded bash step, whose calls
// scenarios/shared/replay.mjs used to make through the SDK. Rerunning
// replaces scenarios/<name>/ whole:
//   scenario.json   v3, Real LayerFS only; each recorded bash step is one bash
//                   step whose command makes the recorded calls in order with
//                   the layerfs command (helpers: scenarios/shared/replay.sh)
//   seed.json       as recorded: the fixture, which the plugin writes out to a
//                   folder when it loads (a seed may hold .git/HEAD, which this
//                   repository cannot keep as a file)
//   changes/        each recorded write's changes, as `layerfs fs apply` reads them
//   final.json      as recorded, for the post-run checks
//   CONVERSION.md   what was kept and removed, and why
//
// What is left out (owner rules, 2026-10-23):
//   rerun          an exec of a command that already ran on the same Branch,
//                  in a Workspace with nothing uncommitted, when nothing on
//                  that Branch changed since (no write, and no Commit the
//                  record has as Committed): dropped with its expect code
//   verification   crew only, verification off: a verification-only command
//                  is dropped unless it is an install (npm install / npm ci),
//                  the last build (npm run build, esbuild, tsc) or the last
//                  test run (npm test, npm run test, node --test) of its
//                  Branch; commands that drive a browser stay out as before
// A Workspace in which no command is left is not mounted at all (its Commits
// would change nothing), and a Commit after no remaining command is dropped.
// A bash step left with no call is dropped; a turn left with no call gets
// one `echo` so its agent's coordination (send_message, reply/until) stays.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readSeed } from "../../packages/mock/src/seed.js";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NAMES = ["shop", "depot", "crew"];

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv.splice(i, 2)[1]; };
const repo = resolve(ROOT, opt("--repo", process.env.LAYERFS_SOURCE || "../layerfs"));
const rev = opt("--rev", "0c7d9c47c1^");
const name = argv[0];
if (!NAMES.includes(name) || argv.length !== 1) {
  console.error(`usage: node tools/replay/convert.mjs <${NAMES.join("|")}> [--repo <layerfs checkout>] [--rev <commit>]`);
  process.exit(2);
}
const fail = (message) => { throw new Error(`${name}: ${message}`); };

// ------------------------------------------------------------------ source
const src = mkdtempSync(join(tmpdir(), "replay-convert-"));
let source;
try {
  const tar = execFileSync("git", ["-C", repo, "archive", "--format=tar", rev, `dsh/scenarios/${name}`], { maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", src], { input: tar });
  const dir = join(src, "dsh/scenarios", name);
  const json = (file) => JSON.parse(readFileSync(join(dir, file), "utf8"));
  source = {
    scenario: json("scenario.json"),
    seed: json("seed.json"),
    seedText: readFileSync(join(dir, "seed.json")),
    final: readFileSync(join(dir, "final.json")),
    runs: new Map(readdirSync(join(dir, "run")).sort().map((f) => [f.replace(/\.json$/, ""), json(`run/${f}`)])),
  };
} finally {
  rmSync(src, { recursive: true, force: true });
}
const { scenario: old, seed, runs } = source;
const history = JSON.parse(source.final.toString("utf8")).history;
if (old.type !== "layerfs-mock-scenario" || old.version !== 2) fail("scenario.json is not a layerfs-mock-scenario v2");
if (!/^sha256:[0-9a-f]{64}$/.test(old.image ?? "")) fail("scenario.json names no runtime image (sha256:…), which its Sandboxes need");

// ------------------------------------------------------------------ the decisions, in recorded order
const INSTALL = /\bnpm (install|ci)\b/;
const BUILD = /\bnpm run build\b|\besbuild\b|\btsc\b/;
const TEST = /\bnpm (run )?test\b|\bnode --test\b/;
const verificationOff = name === "crew";
const changed = (c) => c.expect?.includes("Committed") && !c.generated; // the record's Commit came back Committed

const wsOf = new Map(); // agent|ws -> the live Workspace record
const execs = [];
for (const [number, run] of runs) {
  for (const c of run.calls) {
    c.number = number;
    if (c.op === "mount") wsOf.set(`${run.agent}|${c.ws}`, c.branch);
    if (c.op === "exec") { c.branch = wsOf.get(`${run.agent}|${c.ws}`) ?? fail(`${number}: exec in ${c.ws}, which is not mounted`); execs.push(c); }
  }
}
// crew's kept verification commands: the installs, and each Branch's last build and last test (no browser)
const lastOf = new Set();
if (verificationOff) {
  const lastBuild = new Map(), lastTest = new Map();
  for (const c of execs) {
    if (c.browser) continue;
    if (BUILD.test(c.command)) lastBuild.set(c.branch, c);
    if (TEST.test(c.command)) lastTest.set(c.branch, c);
  }
  for (const c of [...lastBuild.values(), ...lastTest.values()]) lastOf.add(c);
}
const verificationKept = (c) => (!c.browser && INSTALL.test(c.command)) || lastOf.has(c);

const version = new Map(); // Branch -> how many changes it has had
const lost = new Map(); // Branch -> recorded Committed Commits this replay does not make
const ran = new Map(); // Branch, version, command -> the exec that ran it
const ranOnBranch = new Map(); // Branch, command -> the last exec that ran it (for the summary)
const live = new Map(); // agent|ws -> Workspace
const layerAt = []; // publish ordinal -> the publish call
let publishes = 0;
const lifetimes = [];
for (const [number, run] of runs) {
  for (const c of run.calls) {
    const key = `${run.agent}|${c.ws}`;
    switch (c.op) {
      case "mount": {
        const w = { branch: c.branch, version: version.get(c.branch) ?? 0, dirty: false, removedSince: false, kept: 0, calls: [c] };
        live.set(key, w);
        lifetimes.push(w);
        c.w = w;
        break;
      }
      case "exec": {
        const w = live.get(key);
        w.calls.push(c);
        c.w = w;
        if (verificationOff && c.verification && !verificationKept(c)) c.removed = "verification";
        const same = `${w.branch}\0${w.version}\0${c.command}`;
        const before = !w.dirty && w.version !== null ? ran.get(same) : null;
        if (!c.removed && before && before.exit === c.exit && before.expect === c.expect && !c.flaky && !c.sandboxOwn) {
          c.removed = "rerun";
          c.sameAs = before.number;
        }
        if (c.removed) { w.removedSince = true; break; }
        const earlier = ranOnBranch.get(`${w.branch}\0${c.command}`);
        if (earlier) {
          c.ranAgain = { as: earlier.number, why: w.dirty ? "its Workspace held uncommitted changes" : w.version === null ? "its Workspace may not show the Branch's head" : w.version !== earlier.at ? "the Branch changed since (a write or a Commit recorded as Committed)" : c.flaky || c.sandboxOwn ? "its recorded exit is a race or a census" : "its recorded exit differs" };
        }
        ranOnBranch.set(`${w.branch}\0${c.command}`, { number, at: w.version });
        if (!w.dirty && w.version !== null && !ran.has(same)) ran.set(same, c);
        w.dirty = true;
        w.kept++;
        break;
      }
      case "commit": {
        const w = live.get(key);
        w.calls.push(c);
        c.w = w;
        if (!w.dirty) {
          c.removed = "nothing";
          if (changed(c)) lost.set(w.branch, [...(lost.get(w.branch) ?? []), c]);
          w.removedSince = false;
          break;
        }
        c.kinds = c.expect === "sandbox.commit:Committed" && !w.removedSince ? ["Committed"] : ["Committed", "UpToDate"];
        const head = version.get(w.branch) ?? 0;
        if (changed(c)) { version.set(w.branch, head + 1); w.version = head + 1; } else if (w.version !== head) w.version = null;
        w.dirty = false;
        w.removedSince = false;
        break;
      }
      case "unmount": {
        const w = live.get(key);
        w.calls.push(c);
        c.w = w;
        live.delete(key);
        break;
      }
      case "write": version.set(c.branch, (version.get(c.branch) ?? 0) + 1); break;
      case "merge": version.set(c.name, 0); break;
      case "fork": if (c.expect === "branch.fork:Forked") version.set(c.name, 0); break;
      case "publish": c.ordinal = ++publishes; layerAt[publishes] = c; c.lostBefore = (lost.get(c.branch) ?? []).length > 0; break;
      case "create": case "close": break;
      default: fail(`${number}: unknown call ${c.op}`);
    }
  }
}
if (live.size) fail(`Workspaces left mounted at the end: ${[...live.keys()].join(", ")}`);
// a Workspace with no command left is not mounted: its Commits change nothing
for (const w of lifetimes) if (!w.kept) for (const c of w.calls) c.removed ??= "nothing";
// forks from main's Layer n keep that publish's Layer
for (const run of runs.values()) for (const c of run.calls) {
  const layer = c.op === "fork" ? /^L([0-9]+)$/.exec(c.from) : null;
  if (!layer) continue;
  const p = layerAt[Number(layer[1])] ?? fail(`${c.number}: a fork from ${c.from}, which no earlier publish made`);
  if (p.number > c.number) fail(`${c.number}: a fork from ${c.from}, published later`);
  p.keepLayer = Number(layer[1]);
}
// at most 16 Workspaces of an agent at once
{
  const open = new Map();
  for (const run of runs.values()) for (const c of run.calls) {
    if (c.removed || (c.op !== "mount" && c.op !== "unmount")) continue;
    const n = (open.get(run.agent) ?? 0) + (c.op === "mount" ? 1 : -1);
    if (n > 16) fail(`${c.number}: ${run.agent} would hold ${n} Workspaces in its Sandbox`);
    open.set(run.agent, n);
  }
}

// ------------------------------------------------------------------ commands
const SAFE = /^[A-Za-z0-9._\/:@%+=,-]+$/;
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const q = (s) => (SAFE.test(String(s)) ? String(s) : sq(s));
const msg = (m) => (m == null || m === "" ? "" : m.startsWith("-") ? ` --message=${sq(m)}` : ` -m ${sq(m)}`);
const wsKey = (agent, ws) => `ws-${agent}-${ws.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

const changeFiles = new Map(); // file name -> changes
/** The alternatives of a recorded exec expect ("sandbox.exec:exit:1|0"). */
const exits = (c) => {
  const m = /^sandbox\.exec:exit:([0-9|]+)$/.exec(c.expect ?? "");
  const codes = m ? m[1].split("|") : [String(c.exit)];
  if (!codes.includes(String(c.exit))) codes.unshift(String(c.exit));
  return [...new Set(codes)];
};

/** A recorded ref as shell lines that set $from, or a literal argument. */
function fromRef(ref, lines) {
  if (ref === "main" || ref == null) return "";
  const layer = /^L([0-9]+)$/.exec(ref);
  if (layer) { lines.push(`from=$(kept layer-${layer[1]})`); return ` "$from"`; }
  const [, branch, index] = /^(.+)#([0-9]+)$/.exec(ref) ?? [];
  if (!branch) return ` ${q(ref)}`; // a Branch by name: its head now
  const commits = history?.branches?.[branch]?.commits ?? fail(`no recorded history of ${branch} for ${ref}`);
  if (!commits[Number(index)]) fail(`${ref} is past ${branch}'s recorded Commits`);
  const messages = commits.slice(0, Number(index) + 1).reverse().map((c) => sq(c.message));
  lines.push(`# ${ref}: the recorded Commit ${index} of ${branch}, by its message (or the one before it this replay made)`);
  lines.push(`from=$(commit_of ${q(branch)} \\\n  ${messages.join(" \\\n  ")})`);
  return ` "$from"`;
}

/** One recorded step as a command and its expect codes, or null when no call is left. */
function compile(number, run, description) {
  const kept = run.calls.filter((c) => !c.removed);
  if (!kept.length) return null;
  const agent = run.agent;
  const lines = [
    `# ${description.replace(/\n/g, " ")}`,
    "set -eo pipefail",
    'layerfs() { node "$DSH_LAYERFS_CLI" "$@"; }',
    '. "{{scenario}}/../shared/replay.sh"',
  ];
  const expect = [];
  const vars = new Map(); // recorded ws -> shell variable
  const mountedHere = new Set(kept.filter((c) => c.op === "mount").map((c) => c.ws));
  const wsCount = new Set(kept.filter((c) => c.ws).map((c) => c.ws)).size;
  const across = (c) => c.w.calls.some((d) => !d.removed && d.number !== number); // kept calls in another step
  const wsVar = (c) => {
    if (vars.has(c.ws)) return vars.get(c.ws);
    const v = wsCount > 1 ? `ws${vars.size + 1}` : "ws";
    vars.set(c.ws, v);
    if (!mountedHere.has(c.ws)) lines.push(`${v}=$(kept ${wsKey(agent, c.ws)})   # mounted by an earlier step as ${c.ws}`);
    return v;
  };
  let writes = 0, sandboxRead = false;
  const writeCount = kept.filter((c) => c.op === "write").length;
  for (const c of kept) {
    switch (c.op) {
      case "create": {
        const owner = c.for ?? agent;
        // the recorded run's image: the tools its commands need (cargo, Chromium) are in it
        lines.push(`sb=$(layerfs sandbox create --image ${old.image} | field sandbox)`, `keep sandbox-${owner} "$sb"; keep image ${old.image}; echo "Sandbox $sb${owner === agent ? "" : ` for ${owner}`}"`);
        if (owner !== agent) sandboxRead = false;
        expect.push("sandbox.create:ok");
        break;
      }
      case "close":
        lines.push(`close_sandbox ${agent}`);
        expect.push("sandbox.close:Closed|NoSuchSandbox|MountsActive");
        break;
      case "fork": {
        const from = fromRef(c.from, lines);
        if (c.expect === "branch.fork:Forked") lines.push(`layerfs branch fork ${q(c.name)}${from} | kind Forked`);
        else {
          const code = /^branch\.fork:(\w+)$/.exec(c.expect)?.[1] ?? fail(`${number}: fork expects ${c.expect}`);
          lines.push(`refused ${code} branch fork ${q(c.name)}${from}`);
        }
        expect.push(c.expect);
        break;
      }
      case "merge":
        if (c.expect !== "branch.merge:Merged") fail(`${number}: merge expects ${c.expect}`);
        lines.push(`layerfs branch merge ${q(c.a)} ${q(c.b)} ${q(c.name)}${msg(c.message)} | kind Merged`);
        expect.push(c.expect);
        break;
      case "publish": {
        if (c.commit) fail(`${number}: a publish of a named Commit (${c.commit})`);
        if (c.expect !== "branch.publish:Added") fail(`${number}: publish expects ${c.expect}`);
        const kinds = c.lostBefore ? "Added NoChanges" : "Added";
        lines.push(`head=$(layerfs branch list_commits ${q(c.branch)} --page-size 1 | field items.0.id)`);
        if (c.keepLayer) {
          lines.push(`pub=$(layerfs branch publish ${q(c.branch)} "$head" | kind ${kinds})`, `printf '%s\\n' "$pub"`);
          lines.push(`layer=$(printf '%s' "$pub" | field publishedLayer.id)`, `keep layer-${c.keepLayer} "$layer"   # main's Layer ${c.keepLayer}, forked from later`);
        } else lines.push(`layerfs branch publish ${q(c.branch)} "$head" | kind ${kinds}`);
        expect.push(c.lostBefore ? "branch.publish:Added|NoChanges" : c.expect);
        break;
      }
      case "write": {
        const file = writeCount > 1 ? `${number}-${++writes}.json` : `${number}.json`;
        changeFiles.set(file, c.changes);
        lines.push(`layerfs fs apply ${q(c.branch)}${msg(c.message)} --from "{{scenario}}/changes/${file}" | kind Committed   # ${c.changes.length} change(s)`);
        expect.push("fs.apply:Committed");
        break;
      }
      case "mount": {
        const v = wsVar(c);
        if (!sandboxRead) lines.push(`sb=$(sandbox_of ${agent})`);
        sandboxRead = true;
        lines.push(`${v}=$(layerfs workspace mount "$sb" ${q(c.branch)} | field ws); echo "mounted ${c.branch} as $${v}"`);
        if (across(c)) lines.push(`keep ${wsKey(agent, c.ws)} "$${v}"   # recorded as ${c.ws}; a later step uses it`);
        expect.push("workspace.mount:Mounted");
        break;
      }
      case "exec": {
        const v = wsVar(c), codes = exits(c);
        const call = `layerfs workspace exec "$${v}"${msg(c.message)} --stream -- ${sq(c.command)}`;
        if (c.flaky) lines.push(`# exit ${c.exit} in the record came from a racing test only: ${c.flaky.tests?.join("; ") ?? `${c.flaky.errors.join(" or ")} in ${c.flaky.where}`}`);
        if (c.sandboxOwn) {
          lines.push(`out=$(mktemp); code=0; ${call} >"$out" 2>&1 || code=$?; cat "$out"`);
          lines.push(`exit_is "$code" ${codes.join(" ")}`);
          lines.push(`# the census was written for the recorded runtime: it may fail only by finding the Sandbox's own ${c.sandboxOwn.join(", ")}`);
          lines.push(`[ "$code" = ${c.exit} ] || census_own "$out" ${c.sandboxOwn.map(q).join(" ")}`);
        } else {
          lines.push(`code=0; ${call} || code=$?`);
          lines.push(`exit_is "$code" ${codes.join(" ")}`);
        }
        expect.push(`workspace.exec:exit:${codes.join("|")}`);
        break;
      }
      case "commit": {
        const v = wsVar(c);
        lines.push(`layerfs workspace commit "$${v}"${msg(c.message)}${c.force ? " --force" : ""} | kind ${c.kinds.join(" ")}`);
        expect.push(`workspace.commit:${c.kinds.join("|")}`);
        break;
      }
      case "unmount": {
        const v = wsVar(c);
        lines.push(`layerfs workspace unmount "$${v}"${c.discard ? " --discard" : ""} | kind Unmounted`);
        if (!mountedHere.has(c.ws) || across(c)) lines.push(`forget ${wsKey(agent, c.ws)}`);
        expect.push("workspace.unmount:Unmounted");
        break;
      }
      default: fail(`${number}: unknown call ${c.op}`);
    }
  }
  return { command: lines.join("\n"), expect };
}

// ------------------------------------------------------------------ steps
const agents = {};
const counts = { recordedSteps: 0, keptSteps: 0, placeholders: 0, droppedPhases: 0, otherSteps: 0 };
for (const [agent, steps] of Object.entries(old.agents)) {
  const out = [];
  let phase = null, callsInTurn = 0;
  for (const step of steps) {
    if ("pause" in step) continue;
    if (step.bash) {
      counts.recordedSteps++;
      const [call, ...more] = step.bash.run ?? [];
      if (!call || more.length || call[0] !== "step" || call[1] !== name) fail(`${agent}: a bash step that is not one recorded step: ${JSON.stringify(step.bash)}`);
      const run = runs.get(call[2]) ?? fail(`${agent}: no run/${call[2]}.json`);
      if (run.agent !== agent) fail(`${call[2]} is ${run.agent}'s, in ${agent}'s steps`);
      const description = run.step;
      const compiled = compile(call[2], run, description);
      if (!compiled) { if (step.phase && !phase) phase = step.phase; continue; }
      counts.keptSteps++;
      const bash = { description, command: compiled.command };
      if (step.bash.timeoutMs && run.calls.some((c) => c.op === "exec" && !c.removed)) bash.timeoutMs = step.bash.timeoutMs;
      const next = { bash };
      if (step.phase ?? phase) next.phase = step.phase ?? phase;
      if (step.phase && phase && step.phase !== phase) counts.droppedPhases++;
      phase = null;
      if (compiled.expect.length) next.expect = compiled.expect;
      out.push(next);
      callsInTurn++;
      continue;
    }
    counts.otherSteps++;
    if ("reply" in step) {
      if (!callsInTurn) {
        // every call of this turn was dropped: one echo keeps the turn, so the coordination around it stays as recorded
        out.push({ bash: { description: `${agent}: nothing of this turn is left to replay`, command: `echo ${sq(`${agent}: every recorded call of this turn repeats an earlier run or only verifies; nothing is left to replay`)}` } });
        counts.placeholders++;
      }
      const next = { reply: step.reply };
      if (step.until) next.until = step.until;
      if (step.phase) next.phase = step.phase;
      out.push(next);
      callsInTurn = 0;
      continue;
    }
    const tools = ["subagent", "send_message"].filter((t) => t in step);
    if (tools.length !== 1) fail(`${agent}: a step this converter does not know: ${JSON.stringify(step).slice(0, 200)}`);
    const next = { [tools[0]]: step[tools[0]] };
    for (const k of ["say", "phase", "note"]) if (step[k] !== undefined) next[k] = step[k];
    if (phase && !next.phase) { next.phase = phase; phase = null; }
    out.push(next);
    callsInTurn++;
  }
  agents[agent] = out;
}

// ------------------------------------------------------------------ output
const folder = join(ROOT, "scenarios", name);
rmSync(folder, { recursive: true, force: true });
mkdirSync(join(folder, "changes"), { recursive: true });

// fixture: the recorded seed.json as it is (packages/mock/src/seed.js)
writeFileSync(join(folder, "seed.json"), source.seedText);
try { readSeed(join(folder, "seed.json")); } catch (error) { fail(error.message); }
const entries = Object.keys(seed.entries);

for (const [file, changes] of changeFiles) writeFileSync(join(folder, "changes", file), `${JSON.stringify(changes, null, 1)}\n`);
writeFileSync(join(folder, "final.json"), source.final);

const blurb = `Replay of a recorded run: ${old.blurb.replace(/^Replays /, "").replace(/ Every recorded write.*$/, "")} Every recorded write is applied, and a recorded command runs again in a Workspace unless it repeats an earlier run on a Branch that has not changed since${verificationOff ? ", or it only verifies and is not one of the installs or a Branch's last build or test" : ""}.`;
const scenario = { type: "layerfs-scenario", version: 3, title: old.title, blurb, order: old.order, layerfs: ["real"], fixture: "seed.json", agents };
writeFileSync(join(folder, "scenario.json"), `${JSON.stringify(scenario, null, 1)}\n`);

// ------------------------------------------------------------------ summary
const all = [...runs.values()].flatMap((r) => r.calls);
const by = (op, why) => all.filter((c) => c.op === op && c.removed === why).length;
const keptExecs = execs.filter((c) => !c.removed);
const seconds = (list) => (list.reduce((n, c) => n + c.ms, 0) / 1000).toFixed(1);
const lostCommits = [...lost.values()].flat();
// a lost recorded Commit that changed tracked files (not optional in the recorded history)
const required = new Set(Object.entries(history?.branches ?? {}).flatMap(([b, h]) => h.commits.filter((c) => c.via === "exec" && !c.optional).map((c) => `${b}\0${c.message}`)));
const lostTracked = lostCommits.filter((c) => required.has(`${c.w.branch}\0${c.message}`));
const lines = [
  `# ${old.title}: conversion`,
  "",
  `Written by \`node tools/replay/convert.mjs ${name}\` from \`${rev}\` of the layerfs repository (\`dsh/scenarios/${name}/\`). Rerun it to rewrite this folder; do not edit by hand.`,
  "",
  "| | count |",
  "| --- | ---: |",
  `| recorded steps (bash) | ${counts.recordedSteps} |`,
  `| steps kept | ${counts.keptSteps} |`,
  `| coordination steps (subagent, send_message, reply) | ${counts.otherSteps} |`,
  `| turns left with no call, kept by one \`echo\` | ${counts.placeholders} |`,
  `| commands recorded | ${execs.length} |`,
  `| removed: identical re-run on an unchanged Branch | ${by("exec", "rerun")} |`,
  `| removed: verification off${verificationOff ? "" : " (not applied)"} | ${by("exec", "verification")} |`,
  `| commands kept | ${keptExecs.length} |`,
  `| recorded seconds of the commands kept | ${seconds(keptExecs)} |`,
  `| recorded seconds of all commands | ${seconds(execs)} |`,
  `| Workspace mounts kept / recorded | ${all.filter((c) => c.op === "mount" && !c.removed).length} / ${all.filter((c) => c.op === "mount").length} |`,
  `| Workspace Commits kept / recorded | ${all.filter((c) => c.op === "commit" && !c.removed).length} / ${all.filter((c) => c.op === "commit").length} |`,
  `| recorded Committed Commits this replay does not make | ${lostCommits.length} (${lostTracked.length} not optional in the recorded history) |`,
  `| writes (fs.apply) | ${all.filter((c) => c.op === "write").length} |`,
  "",
  "Commands removed as identical re-runs (step: same as step):",
  "",
  ...(execs.filter((c) => c.removed === "rerun").map((c) => `- ${runs.get(c.number).step}: same as ${runs.get(c.sameAs).step}, nothing changed on ${c.branch} since`)),
  ...(by("exec", "rerun") ? [] : ["- none"]),
  "",
  "Commands kept that repeat an earlier kept command on the same Branch, and why they run again:",
  "",
  ...keptExecs.filter((c) => c.ranAgain).map((c) => `- ${runs.get(c.number).step}: same as ${runs.get(c.ranAgain.as).step}; ${c.ranAgain.why}`),
  ...(keptExecs.some((c) => c.ranAgain) ? [] : ["- none"]),
  "",
];
if (verificationOff) {
  lines.push("Verification commands kept (install, or a Branch's last build or test):", "");
  for (const c of keptExecs.filter((c) => c.verification)) lines.push(`- ${runs.get(c.number).step} (${c.branch}; ${[!c.browser && INSTALL.test(c.command) && "install", BUILD.test(c.command) && "build", TEST.test(c.command) && "test"].filter(Boolean).join(", ")}; ${(c.ms / 1000).toFixed(1)} s)`);
  lines.push("");
}
if (lostTracked.length) {
  lines.push("Recorded Commits with tracked changes this replay does not make (main's files may differ from final.json where they reached main):", "");
  for (const c of lostTracked) lines.push(`- ${c.w.branch}: ${c.message}`);
  lines.push("");
}
writeFileSync(join(folder, "CONVERSION.md"), `${lines.join("\n")}\n`);
console.log(lines.filter((l) => l.startsWith("|") && !l.startsWith("| ---") && !l.startsWith("| |")).join("\n"));
console.log(`wrote ${folder}: ${changeFiles.size} changes files, ${entries.length} fixture entries`);
if (!existsSync(join(ROOT, "scenarios/shared/replay.sh"))) console.log("note: scenarios/shared/replay.sh is missing; the commands source it");
