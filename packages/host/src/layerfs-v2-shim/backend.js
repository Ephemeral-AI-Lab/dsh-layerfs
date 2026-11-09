// The @layerfs/backend face over the v2 client: the client IS the backend.
export const LayerFSBackend = { of: (layerfs) => layerfs.client ?? layerfs };
