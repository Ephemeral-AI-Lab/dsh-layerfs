// While the build runs: an fs write to docs, and the refusal that keeps teardown explicit.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// notes between this agent's bash calls, outside the workspace folder (Init would import them)
const NOTES_DIR = join(dirname(dirname(process.env.DSH_LAYERFS_TRACE)), "demo-notes", process.env.DSH_LAYERFS_PROJECT);
const NOTES = join(NOTES_DIR, "sandbox.json");
const notes = () => JSON.parse(readFileSync(NOTES, "utf8"));
const keep = (values) => { mkdirSync(NOTES_DIR, { recursive: true }); writeFileSync(NOTES, JSON.stringify(values)); };
const { LayerFS, isRefusal } = await import(process.env.DSH_LAYERFS_SDK);
const lf = await LayerFS.open(process.env.DSH_LAYERFS_PROJECT);
const show = (what, value) => console.log(`${what} → ${value.kind}`);
const refused = async (what, call, code) => {
  try { show(what, await call()); } catch (error) {
    if (!isRefusal(error, code)) throw error;
    console.log(`${what} → refused ${error.code}: ${error.message.replace(/^\w+: /, "")}`);
  }
};
try {
  const { site } = notes();
  show("fs.write CHANGELOG.md on docs (docs is mounted)", await lf.fs.write("docs", "/CHANGELOG.md", "- docs guide\n", "changelog"));
  await refused("unmount site while it builds", () => lf.workspace.unmount(site), "Busy");
} finally {
  await lf.close();
}
