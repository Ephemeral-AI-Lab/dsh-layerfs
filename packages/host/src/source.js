// The LayerFS checkout this plugin runs on, through the .layerfs link at this
// repository's root. tools/layerfs-source.mjs points that link at
// LAYERFS_SOURCE (else ../layerfs, layerfs.json) when pnpm install or
// pnpm test runs, or with pnpm run link:layerfs. The
// Host's @layerfs/agent, @layerfs/backend and @layerfs/runtime are that
// checkout's api/ (agent/sdk, backend, runtime); its agent skill and Linux build come from there
// too. Nothing of LayerFS is published yet (#428 §8).
import { fileURLToPath } from "node:url";

/** The .layerfs link: the LayerFS checkout's root, as a path through the link. */
export const LAYERFS = fileURLToPath(new URL("../../../.layerfs/", import.meta.url));
