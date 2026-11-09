import * as node from "@layerfs/node";
export class LayerFSRuntime {
  constructor(client) { this.client = client; }
  static async open(settings) {
    return new LayerFSRuntime(node.client({ home: settings.home }));
  }
  get worker() { return { start: async () => {} }; }
  get project() {
    const c = this.client;
    return {
      list: () => c.project.list(),
      async start_init(name, source) { return c.project.init(name, source); },
      async get_state(name) {
        const items = await c.project.list();
        return items.items?.find((p) => p.name === name) ?? null;
      },
    };
  }
  async close() { node.close(); }
}
