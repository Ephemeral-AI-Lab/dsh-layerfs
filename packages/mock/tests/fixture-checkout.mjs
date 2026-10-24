// Linux scenario input must survive a Windows core.autocrlf=true checkout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const folder = mkdtempSync(join(tmpdir(), "layerfs-fixture-checkout-"));
const git = (...args) =>
  execFileSync("git", ["-c", "core.autocrlf=true", ...args], {
    cwd: folder,
    timeout: 5000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
try {
  cpSync(join(root, ".gitattributes"), join(folder, ".gitattributes"));
  cpSync(join(root, "demo-workspace"), join(folder, "demo-workspace"), { recursive: true });
  git("init", "--quiet");
  git("add", ".gitattributes", "demo-workspace");
  // Remove only this test's copied fixture, then exercise Git's checkout rules.
  rmSync(join(folder, "demo-workspace"), { recursive: true });
  git("checkout-index", "--all");
  const paths = readdirSync(join(folder, "demo-workspace"), { recursive: true, withFileTypes: true });
  for (const entry of paths) {
    if (!entry.isFile()) continue;
    const bytes = readFileSync(join(entry.parentPath, entry.name));
    assert.equal(bytes.includes(13), false, `${entry.name}: Linux fixture contains CR`);
  }
  for (const name of ["install.sh", "build.sh", "test.sh", "serve.sh"]) {
    assert.equal(
      readFileSync(join(root, "demo-workspace", name)).includes(13),
      false,
      `${name}: current checkout needs LF normalization`,
    );
  }
  console.log("Linux scenario fixtures remain LF with core.autocrlf=true: PASS");
} finally {
  rmSync(folder, { recursive: true, force: true });
}
