export const LayerFSBackend = {
  of(layerfs) {
    const client = layerfs.client ?? layerfs;
    return {
      store: {
        project: {
          get_comparable: (name) => client.store.get_comparable(name),
          get_history: (name) => client.store.get_history(name),
          get_storage: (name) => client.store.get_storage(name),
        },
      },
    };
  },
};
