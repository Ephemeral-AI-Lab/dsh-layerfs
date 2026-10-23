// Loaded first wherever an agent's process loads LayerFS (sdk.js,
// backend.js, cli.js). dsh lets a plugin set only DSH_* names in a bash
// call, and LayerFS reads LAYERFS_* names only, so each DSH_LAYERFS_<NAME>
// becomes LAYERFS_<NAME> unless that is already set. Nothing else is read,
// written or logged.
const PREFIX = "DSH_LAYERFS_";
for (const [name, value] of Object.entries(process.env)) {
  const target = `LAYERFS_${name.slice(PREFIX.length)}`;
  if (name.startsWith(PREFIX) && process.env[target] === undefined) process.env[target] = value;
}
