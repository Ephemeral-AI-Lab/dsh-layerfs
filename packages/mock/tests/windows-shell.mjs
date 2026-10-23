import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { windowsCall } from "../src/windows-shell.js";
import { cliPlan } from "../src/windows-cli.js";

let cliSteps = 0;
function checkCommands(plan) {
  for (const pipeline of plan) for (const command of pipeline) {
    const first = command.words[0][0];
    const assignment = command.words.length === 1 && /^[A-Za-z_][A-Za-z_0-9]*=$/.test(first);
    const literalRead = JSON.stringify(command.words.slice(0, 5)) === JSON.stringify([["IFS="], ["read"], ["-r"], ["-d"], [""]]) && command.words.length === 6 && command.input !== undefined;
    assert.ok(["layerfs", "jq", "tee"].includes(first) || assignment || literalRead, `unexpected host executable ${first}`);
    for (const word of command.words) for (const part of word) if (part.commands) checkCommands(part.commands);
  }
}
for (const name of ["parallel", "conflicts", "shop", "crew", "checkpoints"]) {
  const scenario = JSON.parse(readFileSync(new URL(`../../../scenarios/${name}/scenario.json`, import.meta.url), "utf8"));
  for (const steps of Object.values(scenario.agents)) for (const step of steps) if (step.bash) {
    const plan = cliPlan(step.bash.command);
    assert.ok(plan.length, `${name}: ${step.bash.description}`);
    checkCommands(plan); cliSteps++;
  }
}
assert.throws(() => cliPlan("layerfs help && echo ignored"), /Unsupported/);
assert.deepEqual(cliPlan(`layerfs workspace exec "$ws" "sed -i 's/\\(old\\)/new/' file"`)[0][0].words[4], ["sed -i 's/\\(old\\)/new/' file"]);
assert.deepEqual(cliPlan(`layerfs fs write main /x -m 'it'"'"'s literal'`)[0][0].words[6], ["it's literal"]);
console.log(`windows-shell: parsed ${cliSteps} CLI steps`);

if (process.platform !== "win32") {
  console.log("windows-shell: NOT_RUN (Windows only)");
} else {
  const dir = mkdtempSync(join(tmpdir(), "layerfs-shell-'中文-"));
  try {
    const command = "node --input-type=module <<'JS'\nconsole.log('héllo 中文 $HOME'); process.exit(7);\nJS";
    const call = windowsCall({ name: "bash", args: { command, run_in_background: true } }, dir);
    assert.equal(call.args.run_in_background, true);
    assert.equal(call.args.timeoutMs, 120000);
    const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", call.args.command], { encoding: "utf8", timeout: 20000 });
    assert.equal(run.status, 7, run.stderr);
    assert.match(run.stdout, /héllo 中文 \$HOME/);
    assert.deepEqual(readdirSync(dir), []);
    const other = { name: "subagent", args: { prompt: "unchanged" } };
    assert.equal(windowsCall(other, dir), other);
    const fake = join(dir, "cli.mjs");
    writeFileSync(fake, `import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_CALLS, JSON.stringify({args, input: readFileSync(0, 'utf8')}) + '\\n');
if (args[0] === 'sandbox') console.log(JSON.stringify({sandbox:'box'}));
else if (args[0] === 'workspace' && args[1] === 'mount') console.log(JSON.stringify({ws:'workspace'}));
else if (args[0] === 'fail') process.exit(7);
`);
    const log = join(dir, "calls.jsonl");
    const big = "中文 x".repeat(10000);
    const source = `sb=$(layerfs sandbox create | jq -r .sandbox)
ws=$(layerfs workspace mount "$sb" main | tee mount.json | jq -r .ws)
layerfs fs write main /file -m 'quoted "value"' <<'EOF'
Unicode 中文 $literal
EOF
IFS= read -r -d '' cmd <<'CMD'
${big}
literal $variable \\backslash "quotes"
CMD
layerfs workspace exec "$ws" "$cmd" --stream
layerfs workspace unmount "$(jq -r .ws mount.json)"
layerfs fail`;
    const cli = windowsCall({ name: "bash", args: { command: source } }, dir);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cli.args.command], {
      cwd: dir, env: { ...process.env, DSH_LAYERFS_CLI: fake, TEST_CALLS: log }, encoding: "utf8", timeout: 20000,
    });
    assert.equal(result.status, 7, result.stderr);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 6);
    assert.deepEqual(calls[1].args, ["workspace", "mount", "box", "main"]);
    assert.deepEqual(calls[2], { args: ["fs", "write", "main", "/file", "-m", 'quoted "value"'], input: "Unicode 中文 $literal\n" });
    assert.deepEqual(calls[3].args, ["workspace", "exec", "workspace", `${big}\nliteral $variable \\backslash "quotes"\n`, "--stream"]);
    assert.deepEqual(calls[4].args, ["workspace", "unmount", "workspace"]);
    assert.equal(readdirSync(dir).filter(name => name.endsWith(".json")).length, 1, "only tee output remains");
    const hanging = join(dir, "hanging.mjs");
    const pids = join(dir, "owned-pids.json");
    writeFileSync(hanging, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'});
writeFileSync(process.env.TEST_PIDS, JSON.stringify([process.pid, descendant.pid]));
setInterval(() => {}, 1000);
`);
    const deadline = spawnSync(process.execPath, [fileURLToPath(new URL("../src/windows-command.js", import.meta.url)), "1000", hanging], {
      env: { ...process.env, TEST_PIDS: pids }, encoding: "utf8", timeout: 10000,
    });
    assert.equal(deadline.status, 124, deadline.stderr);
    assert.match(deadline.stderr, /exceeded its 1000 ms wall deadline/);
    for (const pid of JSON.parse(readFileSync(pids, "utf8"))) {
      assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH", `owned process ${pid} survived timeout`);
    }
    console.log("windows-shell: PASS (native Node, Unicode, quotes, exit status, cleanup)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
