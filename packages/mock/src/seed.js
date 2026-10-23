// A scenario's fixture given as a seed file (format layerfs-demo-seed v1):
// the files a recorded run's project was Inited from, as JSON, because some
// of them (a .git/HEAD) cannot live in this repository as files. The plugin
// writes the seed out under its state folder when it loads, and that folder
// is the project's Init source.
//
// seed.json: { format: "layerfs-demo-seed", version: 1, entries: {
//   "/<path>": { type: "file", mode?, text } | { type: "file", mode?, base64 }
//            | { type: "dir", mode? } | { type: "symlink", target } } }
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FIELDS = ["type", "mode", "text", "base64", "target"];

/** Reads and checks a seed file; throws naming the entry at fault. */
export function readSeed(file) {
  const seed = JSON.parse(readFileSync(file, "utf8"));
  if (seed?.format !== "layerfs-demo-seed" || seed.version !== 1) throw new Error(`${file}: not a layerfs-demo-seed v1`);
  for (const [path, e] of Object.entries(seed.entries ?? {})) {
    if (!path.startsWith("/") || path === "/" || path.split("/").slice(1).some((p) => !p || p === "." || p === "..")) throw new Error(`${file}: entry ${path} is not a plain absolute path`);
    for (const k of Object.keys(e)) if (!FIELDS.includes(k)) throw new Error(`${file}: entry ${path} has an unknown field ${k}`);
    if (!["file", "dir", "symlink"].includes(e.type)) throw new Error(`${file}: entry ${path} has an unknown type ${e.type}`);
  }
  return seed;
}

/** Writes `file`'s entries into `to`, replacing whatever was there, and returns `to`. */
export function writeSeed(file, to) {
  const entries = Object.entries(readSeed(file).entries ?? {}).sort(([a], [b]) => a.localeCompare(b));
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const [path, e] of entries) {
    const at = join(to, path);
    if (e.type === "dir") mkdirSync(at, { recursive: true });
    else if (e.type === "symlink") { mkdirSync(dirname(at), { recursive: true }); symlinkSync(e.target, at); }
    else { mkdirSync(dirname(at), { recursive: true }); writeFileSync(at, e.text !== undefined ? e.text : Buffer.from(e.base64 ?? "", "base64")); }
  }
  // modes last, deepest first, so a read-only folder does not stop its own files
  for (const [path, e] of entries.reverse()) if (e.type !== "symlink" && e.mode !== undefined) chmodSync(join(to, path), e.mode);
  return to;
}
