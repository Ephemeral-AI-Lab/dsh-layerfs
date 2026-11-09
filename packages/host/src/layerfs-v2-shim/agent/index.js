import * as node from "@layerfs/node";
export const LayerFS = {
  async open(project) {
    const client = node.client({ home: process.env.LAYERFS_HOME });
    return { project, client, close: () => node.close() };
  },
};
