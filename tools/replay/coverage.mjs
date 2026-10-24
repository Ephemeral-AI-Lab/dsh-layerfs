// The LayerFS outcome codes the scenarios' `expect` checks, as
// method:outcome, one per line, sorted. Alternatives (`a:X|Y`) count as both.
//   node tools/replay/coverage.mjs <rev> <name>...   (rev "-" reads the checkout)
// Compare two revisions with comm, e.g. the codes a conversion lost:
//   comm -23 <(node tools/replay/coverage.mjs 087cbc4 tour) <(node tools/replay/coverage.mjs - tour)
// Before version 3 an expect entry could be a bare outcome (`Mounted`), which
// matched any method; it shows here without a method.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const [rev, ...names] = process.argv.slice(2);
if (!rev || !names.length) {
  console.error("usage: coverage.mjs <rev|-> <scenario>...");
  process.exit(2);
}
const read = (name) =>
  JSON.parse(
    rev === "-"
      ? readFileSync(join(ROOT, "scenarios", name, "scenario.json"), "utf8")
      : execFileSync("git", ["-C", ROOT, "show", `${rev}:scenarios/${name}/scenario.json`], { encoding: "utf8" }),
  );

const codes = new Set();
for (const name of names) {
  for (const steps of Object.values(read(name).agents)) {
    for (const step of steps) {
      for (const code of step.expect ?? []) {
        const [first, ...alts] = code.split("|");
        const head = first.slice(0, first.lastIndexOf(":") + 1);
        for (const one of [first, ...alts.map((alt) => head + alt)]) codes.add(one);
      }
    }
  }
}
console.log([...codes].sort().join("\n"));
