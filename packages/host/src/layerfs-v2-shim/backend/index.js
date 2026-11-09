export const LayerFSBackend = {
  of(layerfs) {
    const client = layerfs.client ?? layerfs;
    return {
      store: {
        project: {
          get_comparable: (name) => client.branch.diff(name),
          get_history: (name) => client.commit.list(name),
          get_storage: (name) => client.store.stats(name),
        },
      },
    };
  },
};
