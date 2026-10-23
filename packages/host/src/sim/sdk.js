// @layerfs/agent for a simulated project: the package itself, its binding
// calls sent to the simulator (binding.js). The Host gives a simulated
// project's bash calls this as DSH_LAYERFS_SDK, so their scripts do not
// change. The binding is chosen when the process's first client is made,
// after this module has set LAYERFS_NATIVE.
import { fileURLToPath } from "node:url";

process.env.LAYERFS_NATIVE = fileURLToPath(new URL("./binding.js", import.meta.url));

export * from "@layerfs/agent";
