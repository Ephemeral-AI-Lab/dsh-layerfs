// The @layerfs/agent face over the v2 @layerfs/node client.
import * as node from "@layerfs/node";
export const LayerFS = {
  async open(project) {
    const home = process.env.LAYERFS_HOME;
    const client = node.client({ home });
    return { project, client, close: () => node.close() };
  },
};
