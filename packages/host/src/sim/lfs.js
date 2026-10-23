#!/usr/bin/env node
// @layerfs/runtime's `lfs` command for a simulated project (DSH_LAYERFS_CLI):
// the command itself, its calls sent to the simulator; see sdk.js.
import { fileURLToPath } from "node:url";

process.env.LAYERFS_NATIVE = fileURLToPath(new URL("./binding.js", import.meta.url));
await import("@layerfs/runtime/cli");
