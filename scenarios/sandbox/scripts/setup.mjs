// Two Branches, two Workspaces in one Sandbox this script starts, which has room for 16.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// notes between this agent's bash calls, outside the workspace folder (Init would import them)
const NOTES_DIR = join(dirname(dirname(process.env.DSH_LAYERFS_TRACE)), "demo-notes", process.env.DSH_LAYERFS_PROJECT);
const NOTES = join(NOTES_DIR, "sandbox.json");
const notes = () => JSON.parse(readFileSync(NOTES, "utf8"));
const keep = (values) => { mkdirSync(NOTES_DIR, { recursive: true }); writeFileSync(NOTES, JSON.stringify(values)); };
const { LayerFS, isRefusal } = await import(process.env.DSH_LAYERFS_SDK);
const project = process.env.DSH_LAYERFS_PROJECT;
const lf = await LayerFS.open(project);
const show = (what, value) => console.log(`${what} → ${value.kind}`);
// One attempt: LayerFS queues concurrent writers itself, so a call is never retried here.
const settle = (call) => call();
const run = async (ws, command) => {
  const r = await lf.workspace.exec(ws, command);
  console.log(`$ ${command}  → ${r.kind}\n${r.stdout}${r.stderr}`.trimEnd());
  return r;
};
try {
  show("fork docs", await settle(() => lf.branch.fork("docs")));
  show("fork site", await settle(() => lf.branch.fork("site")));
  const { sandbox } = await lf.sandbox.create();
  console.log(`sandbox.create → Sandbox ${sandbox}`);
  const docs = await lf.workspace.mount(sandbox, "docs");
  const site = await lf.workspace.mount(sandbox, "site");
  console.log(`docs at Sandbox ${docs.sandbox} ${docs.path}, site at Sandbox ${site.sandbox} ${site.path}`);
  keep({ sandbox, docs, site });
  await run(docs, "mkdir -p docs && cp README.md docs/guide.md && sed -i 's/Website/Guide/' docs/guide.md && cat docs/guide.md");
  await run(site, "sh install.sh");
  await run(site, "test -f docs/guide.md && echo 'site sees docs/guide.md' || echo 'site cannot see docs/guide.md: separate overlays'");
} finally {
  await lf.close();
}
