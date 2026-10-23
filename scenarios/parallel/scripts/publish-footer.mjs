// The main agent publishes footer-2, then checks main.
const { LayerFS, isRefusal } = await import(process.env.DSH_LAYERFS_SDK);
const lf = await LayerFS.open(process.env.DSH_LAYERFS_PROJECT);
const show = (what, value) => console.log(`${what} → ${value.kind}`);
// One attempt: LayerFS queues concurrent writers itself, so a call is never retried here.
const settle = (call) => call();
try {
  show("publish footer-2", await settle(() => lf.branch.publish("footer-2")));
  const files = (await lf.fs.list("main", "/app")).items.map((i) => i.path.split("/").pop());
  console.log(`main /app: ${files.join(" ")}`);
} finally {
  await lf.close();
}
