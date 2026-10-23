#!/usr/bin/env node
// The layerfs command for a simulated project (DSH_LAYERFS_CLI): LayerFS's
// own cli/src/layerfs.js, its @layerfs/agent calls sent to the simulator
// (binding.js). The binding is chosen when the command makes its client,
// after this module has set LAYERFS_NATIVE; see sdk.js.
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LAYERFS } from "../source.js";

process.env.LAYERFS_NATIVE = fileURLToPath(new URL("./binding.js", import.meta.url));
await import(pathToFileURL(join(LAYERFS, "cli/src/layerfs.js")).href);
