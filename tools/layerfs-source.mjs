// Points .layerfs at the LayerFS checkout this repository builds on, and
// checks it against the pin. The checkout is LAYERFS_SOURCE, else layerfs.json's
// `source` (../layerfs beside this repository); a relative path resolves from
// this repository's root. Everything of LayerFS (the SDK the Host links as
// @layerfs/sdk, the agent skill, the Linux build) is read through .layerfs.
//   node tools/layerfs-source.mjs [link]   point .layerfs (pnpm install and pnpm test run this first;
//                                          pnpm skips preinstall when nothing else changed)
//   node tools/layerfs-source.mjs check    also fail unless the checkout is at the pinned commit
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LINK = join(ROOT, ".layerfs");
const pin = JSON.parse(readFileSync(join(ROOT, "layerfs.json"), "utf8"));
const mode = process.argv[2] ?? "link";
if (mode !== "link" && mode !== "check") {
  console.error("usage: node tools/layerfs-source.mjs [link|check]");
  process.exit(2);
}

const source = resolve(ROOT, process.env.LAYERFS_SOURCE || pin.source);
if (!existsSync(join(source, "sdk/js/package.json"))) {
  console.error(`layerfs-source: ${source} is not a LayerFS checkout (no sdk/js/package.json); set LAYERFS_SOURCE to one at ${pin.commit.slice(0, 10)}`);
  process.exit(1);
}

let current = null;
try { if (lstatSync(LINK).isSymbolicLink()) current = resolve(ROOT, readlinkSync(LINK)); else throw new Error(`${LINK} exists and is not a link; remove it`); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (current !== source) {
  if (current !== null) rmSync(LINK);
  // a junction on Windows needs no extra privilege
  symlinkSync(source, LINK, process.platform === "win32" ? "junction" : "dir");
}

let head = null;
try { head = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
const at = head === pin.commit ? "at the pinned commit" : head ? `at ${head.slice(0, 10)}, not the pinned ${pin.commit.slice(0, 10)}` : `not a git checkout (pinned ${pin.commit.slice(0, 10)})`;
console.log(`layerfs-source: .layerfs -> ${source}, ${at}`);
if (mode === "check" && head !== pin.commit) process.exit(1);
