import * as node from "@layerfs/node";

// The @layerfs/runtime face over the v2 client: no worker, no job polling.
// V1 shapes kept where the Host consumes them: project.list answers a bare
// array of {name, initialized} - v2 answers {items} without the flag, and a
// project that lists is initialized; get_state derives from the list.
export class LayerFSRuntime {
  constructor(client) { this.client = client; }
  static async open(settings) {
    return new LayerFSRuntime(node.client({ home: settings.home }));
  }
  get worker() { return { start: async () => {} }; }
  get project() {
    const c = this.client;
    return {
      list: async () => {
        const page = await c.project.list();
        const items = Array.isArray(page) ? page : page.items ?? [];
        return items.map((p) => ({ ...p, initialized: p.initialized ?? true }));
      },
      async start_init(name, source) { return c.project.init(name, source); },
      async get_state(name) {
        const items = await this.list();
        return items.find((p) => p.name === name) ?? null;
      },
    };
  }
  async close() { node.close(); }
}
