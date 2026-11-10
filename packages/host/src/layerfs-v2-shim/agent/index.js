import * as node from "@layerfs/node";

export const LayerFSError = node.LayerFSError;

// Tests substitute the client open uses (the shim answer to spec.runtime:
// one injection point, keeping the real SDK as the default).
let standIn = null;
export const LayerFS = {
  use(factory) { standIn = factory; },
  async open(project) {
    const client = standIn ? standIn() : node.client({ home: process.env.LAYERFS_HOME });
    return { project, client, close: () => (client && client.close ? client.close() : node.close()) };
  },
};
