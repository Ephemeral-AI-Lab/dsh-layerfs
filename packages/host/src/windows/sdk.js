// Keep the SDK API on Windows; its native boundary is the authenticated WSL worker.
import { fileURLToPath } from "node:url";
import { LayerFS as SDKLayerFS } from "@layerfs/sdk";
import { configure } from "./binding.js";

process.env.LAYERFS_NATIVE = fileURLToPath(new URL("./binding.js", import.meta.url));
export { LayerFSError, isRefusal, CODES } from "@layerfs/sdk";
export class LayerFS extends SDKLayerFS {
  constructor(name, options) {
    super(name, options);
    configure(this.options.home, process.env.LAYERFS_WSL_ENDPOINT || process.env.DSH_LAYERFS_WSL_ENDPOINT);
  }
}
