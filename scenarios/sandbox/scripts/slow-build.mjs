// Start the slow site build as a Sandbox process and wait for it here; as a
// background bash job, this leaves the agent free while the build runs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// notes between this agent's bash calls, outside the workspace folder (Init would import them)
const NOTES_DIR = join(dirname(dirname(process.env.DSH_LAYERFS_TRACE)), "demo-notes", process.env.DSH_LAYERFS_PROJECT);
const NOTES = join(NOTES_DIR, "sandbox.json");
const notes = () => JSON.parse(readFileSync(NOTES, "utf8"));
const keep = (values) => { mkdirSync(NOTES_DIR, { recursive: true }); writeFileSync(NOTES, JSON.stringify(values)); };
const { LayerFS } = await import(process.env.DSH_LAYERFS_SDK);
const lf = await LayerFS.open(process.env.DSH_LAYERFS_PROJECT);
const show = (what, value) => console.log(`${what} → ${value.kind}`);
const run = async (ws, command) => {
  const r = await lf.workspace.exec(ws, command);
  console.log(`$ ${command}  → ${r.kind}\n${r.stdout}${r.stderr}`.trimEnd());
  return r;
};
const { LayerFSBackend } = await import(process.env.DSH_LAYERFS_BACKEND);
try {
  const { site } = notes();
  const op = LayerFSBackend.of(lf).daemon;
  const build = await op.process.start(site, "sh build.sh --slow");
  console.log(`start sh build.sh --slow → ${build.kind} (${build.process})`);
  for (let status = "running"; status === "running"; ) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    status = (await op.process.list()).items.find((p) => p.id === build.process)?.status ?? "gone";
    if (status !== "running") console.log(`build ${status}`);
  }
  await run(site, "cat .next/BUILD_ID && ls .next/server/app");
} finally {
  await lf.close();
}
