// header: fork header from main, write app/header.tsx with fs, then test the Branch in a Workspace.
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
  show("fork header", await settle(() => lf.branch.fork("header")));
  show("write app/header.tsx", await lf.fs.write("header", "/app/header.tsx", "export const Header = () => <header>LayerFS</header>;\n", "add app/header.tsx"));
  const { sandbox } = await lf.sandbox.create();
  const ws = await lf.workspace.mount(sandbox, "header");
  console.log(`mount header → Sandbox ${ws.sandbox} ${ws.path}`);
  await run(ws, "sh test.sh && ls app");
  show("unmount", await lf.workspace.unmount(ws));
  show(`close Sandbox ${sandbox}`, await lf.sandbox.close(sandbox));
  const [head] = (await lf.branch.list_commits("header")).items;
  console.log(`ready: Branch header at Commit ${head.id.slice(0, 12)}`);
} finally {
  await lf.close();
}
