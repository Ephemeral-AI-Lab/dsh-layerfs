import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIN, shimOnPath } from "../src/cli-path.js";

const pathEnv = { Path: "C:\\Windows;C:\\Tools" };
const restore = shimOnPath(pathEnv, "win32");
assert.equal(pathEnv.Path, `${BIN};C:\\Windows;C:\\Tools`);
assert.equal(pathEnv.PATH, undefined);
restore();
assert.equal(pathEnv.Path, "C:\\Windows;C:\\Tools");

if (process.platform !== "win32") {
  console.log("windows-cli: NOT_RUN (Windows only)");
} else {
  const dir = mkdtempSync(join(tmpdir(), "layerfs cli "));
  try {
    const cli = join(dir, "fake cli.mjs");
    writeFileSync(
      cli,
      `import { readFileSync } from 'node:fs';
console.log(JSON.stringify({ args: process.argv.slice(2), input: readFileSync(0, 'utf8') }));
console.error('cli stderr'); process.exit(125);`,
    );
    const env = { ...process.env, DSH_LAYERFS_CLI: cli };
    shimOnPath(env);
    for (const [shell, args] of [
      [
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "layerfs fs read main '/a file.txt'; exit $LASTEXITCODE"],
      ],
      ["cmd.exe", ["/d", "/c", 'layerfs fs read main "/a file.txt"']],
    ]) {
      const run = spawnSync(shell, args, {
        env,
        encoding: "utf8",
        input: "stdin payload\n",
        timeout: 10000,
        windowsVerbatimArguments: shell === "cmd.exe",
      });
      assert.equal(run.status, 125, run.stderr);
      assert.deepEqual(
        JSON.parse(run.stdout),
        { args: ["fs", "read", "main", "/a file.txt"], input: "stdin payload\n" },
        shell,
      );
      assert.equal(run.stderr.trim(), "cli stderr");
    }
    const missing = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "layerfs help; exit $LASTEXITCODE"],
      { env: { ...env, DSH_LAYERFS_CLI: "" }, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /this conversation has no LayerFS project/);
    console.log(
      "windows-cli: PASS (PowerShell and cmd PATH, spaced paths/args, stdin, stderr, exit 125 and missing-project exit 2)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
