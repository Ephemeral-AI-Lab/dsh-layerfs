// Commands in a simulated Workspace: /bin/sh in the Workspace's folder with a
// plain environment, and GNU sed on macOS (bin/sed, sed.js). A foreground
// command is waited for; a background one runs detached in its own process
// group and leaves its output and exit code in files the next call reads.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("./bin", import.meta.url));
const SED = fileURLToPath(new URL("./sed.js", import.meta.url));
const MAX_OUTPUT = 1024 * 1024;
const TIMEOUT_MS = 10 * 60_000;

const environment = (dir) => ({
  PATH: [...(process.platform === "darwin" ? [BIN] : []), "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
  HOME: dir,
  PWD: dir,
  LAYERFS_SIM_NODE: process.execPath,
  LAYERFS_SIM_SED: SED,
});

/** Whether process `pid` is alive (a process of another user counts). */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/**
 * Runs `command` in `dir` and waits for it.
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, truncated: boolean }>}
 */
export function runCommand(dir, command) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd: dir, env: environment(dir), stdio: ["ignore", "pipe", "pipe"], detached: true });
    const out = { stdout: "", stderr: "" };
    let truncated = false;
    for (const name of ["stdout", "stderr"]) {
      child[name].setEncoding("utf8").on("data", (text) => {
        if (out[name].length + text.length > MAX_OUTPUT) { truncated = true; text = text.slice(0, Math.max(0, MAX_OUTPUT - out[name].length)); }
        out[name] += text;
      });
    }
    const timer = setTimeout(() => stopCommand(child.pid), TIMEOUT_MS);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 128 + (signal === "SIGKILL" ? 9 : 15), ...out, truncated });
    });
  });
}

/** Starts `command` in `dir` in the background; `log` takes its output, `codeFile` its exit code. @returns its pid */
export function startCommand(dir, command, log, codeFile) {
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "a");
  try {
    const child = spawn("/bin/sh", ["-c", '/bin/sh -c "$1"; echo $? > "$2"', "layerfs-sim", command, codeFile], { cwd: dir, env: environment(dir), stdio: ["ignore", fd, fd], detached: true });
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

/** Stops a command's process group. */
export function stopCommand(pid) {
  if (!alive(pid)) return;
  try { process.kill(-pid, "SIGTERM"); } catch { /* it ended */ }
}
