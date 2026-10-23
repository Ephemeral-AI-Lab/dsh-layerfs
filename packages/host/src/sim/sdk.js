// The LayerFS SDK of a simulated project: the SDK itself, its native calls
// sent to the simulator's binding (binding.js). The Host gives a simulated
// project's bash calls this as DSH_LAYERFS_SDK, so their scripts do not change.
import { fileURLToPath } from "node:url";

process.env.LAYERFS_NATIVE = fileURLToPath(new URL("./binding.js", import.meta.url));

export * from "@layerfs/sdk";
