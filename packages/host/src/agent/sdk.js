// @layerfs/agent as agents' scripts import it (DSH_LAYERFS_SDK): its exports,
// after env.js has set LAYERFS_* from DSH_LAYERFS_*. The SDK reads its
// settings at LayerFS.open and per call, never at load.
import "./env.js";
export * from "@layerfs/agent";
