// The main agent publishes: header first.
const { LayerFS, isRefusal } = await import(process.env.DSH_LAYERFS_SDK);
const lf = await LayerFS.open(process.env.DSH_LAYERFS_PROJECT);
const show = (what, value) => console.log(`${what} → ${value.kind}`);
// One attempt: LayerFS queues concurrent writers itself, so a call is never retried here.
const settle = (call) => call();
try {
  const p = await settle(() => lf.branch.publish("header"));
  console.log(`publish header → ${p.kind}: main is at ${p.publishedLayer.id.slice(0, 12)}`);
} finally {
  await lf.close();
}
