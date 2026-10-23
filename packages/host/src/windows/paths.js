// Windows paths stay on the caller; SDK runtime paths belong to one WSL distribution.
import { execFile } from "node:child_process";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const wslArgs = (windows, args) => ["--distribution", windows.distribution, "--user", windows.user, "--exec", ...args];
export const wsl = (windows, args, options = {}) => execute("wsl.exe", wslArgs(windows, args), { windowsHide: true, ...options });

export function absoluteLinux(path, label) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0") || path.includes("\\"))
    throw new Error(`${label} must be an absolute Linux path in the selected WSL distribution`);
  return posix.normalize(path);
}

/** UNC paths must name our distribution; drive paths use its actual automount configuration. */
export async function linuxPath(path, windows) {
  if (typeof path !== "string" || path.includes("\0")) throw new Error("invalid Windows import path");
  const unc = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i.exec(path);
  if (unc) {
    if (unc[1].toLowerCase() !== windows.distribution.toLowerCase()) throw new Error("the import path names another WSL distribution");
    return absoluteLinux((unc[2] || "\\").replaceAll("\\", "/"), "import path");
  }
  if (path.startsWith("/")) return absoluteLinux(path, "import path");
  if (!/^[a-z]:[\\/]/i.test(path) || !win32.isAbsolute(path)) throw new Error("an import path must be absolute");
  const { stdout } = await wsl(windows, ["wslpath", "-a", "-u", path], { timeout: 5000 });
  return absoluteLinux(stdout.trim(), "translated import path");
}

export function projectHome(windows, name) {
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(name)) throw new Error("invalid project name");
  const root = absoluteLinux(windows.home, "wslHome"), path = posix.join(root, name);
  if (posix.dirname(path) !== root) throw new Error("project escapes its WSL home");
  return path;
}
