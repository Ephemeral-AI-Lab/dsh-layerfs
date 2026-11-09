export const LayerFSBackend = {
  of(layerfs) {
    const client = layerfs.client ?? layerfs;
    const project = layerfs.project ?? null;
    const store = project ? project.split("/")[0] : null;
    return {
      store: {
        project: {
          get_comparable: () => client.branch.diff(project),
          get_history: () => client.commit.list(project),
          get_storage: () => client.store.stats(store),
        },
      },
    };
  },
};
