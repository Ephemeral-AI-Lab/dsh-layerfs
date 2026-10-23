// footer: main moved since footer was forked. Publish overwrites, so bring main in
// on a new Branch; merge never changes its inputs.
const { LayerFS, isRefusal } = await import(process.env.DSH_LAYERFS_SDK);
const lf = await LayerFS.open(process.env.DSH_LAYERFS_PROJECT);
const show = (what, value) => console.log(`${what} → ${value.kind}`);
// One attempt: LayerFS queues concurrent writers itself, so a call is never retried here.
const settle = (call) => call();
try {
  const m = await settle(() => lf.branch.merge("footer", "main", "footer-2", "bring in the header"));
  console.log(`merge footer + main into footer-2 → ${m.kind}`);
  const files = (await lf.fs.list("footer-2", "/app")).items.map((i) => i.path.split("/").pop());
  console.log(`footer-2 /app: ${files.join(" ")}`);
} finally {
  await lf.close();
}
