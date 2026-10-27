// The layerfs command in an agent's process (DSH_LAYERFS_CLI, run by
// bin/layerfs): LayerFS's CLI entry, after env.js has set LAYERFS_* from
// DSH_LAYERFS_*. The entry reads process.argv.slice(2) and exits with its
// code, so `node cli.js <args>` runs as `node layerfs.js <args>`.
import "./env.js";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LAYERFS } from "../source.js";

await import(pathToFileURL(join(LAYERFS, "api/cli/src/layerfs.js")).href);
