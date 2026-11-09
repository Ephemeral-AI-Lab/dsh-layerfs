// The @layerfs/runtime face over the v2 client: no worker, no job polling.
import * as node from "@layerfs/node";
export class LayerFSRuntime {
  constructor(client) { this.client = client; }
  static async open(settings) {
    const client = node.client({ home: settings.home });
    return new LayerFSRuntime(client);
  }
  get worker() { return { start: async () => {} }; }
  get project() {
    const c = this.client;
    return {
      list: () => c.project.list(),
      async start_init(name, source) { return c.project.init(name, source); },
      get_state: async (name) => { const items = await c.project.list(); return items.items?.find((p) => p.name === name) ?? null; },
    };
  }
  async close() { node.close(); }
}
