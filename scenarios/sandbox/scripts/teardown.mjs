// Teardown: commit docs (it merges with the fs write), unmount both, then
// close the Sandbox setup started.
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
try {
  const { sandbox, docs, site } = notes();
  const c = await lf.workspace.commit(docs, "docs guide");
  console.log(`commit docs → ${c.kind}${c.merged ? " (merged with the head first)" : ""}`);
  show("unmount docs", await lf.workspace.unmount(docs));
  try {
    await lf.workspace.unmount(site);
  } catch (error) {
    if (!isRefusal(error, "Dirty")) throw error;
    console.log(`unmount site → refused Dirty: ${(error.detail?.changed ?? []).slice(0, 4).join(", ")}`);
  }
  show("unmount site, discarding the build output", await lf.workspace.unmount(site, true));
  show(`close Sandbox ${sandbox}`, await lf.sandbox.close(sandbox));
  show("fs.write README.md on docs", await lf.fs.write("docs", "/README.md", "# Website docs\n", "docs readme"));
  const files = (await lf.fs.list("docs", "/")).items.map((i) => i.path.split("/").pop());
  console.log(`docs /: ${files.join(" ")}`);
} finally {
  await lf.close();
}
