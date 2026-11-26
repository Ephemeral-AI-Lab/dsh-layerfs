/**
 * The host events that make an answer the client already holds wrong, and what
 * each one invalidates. `api.ts` drops the shared sends whose keys match;
 * Home's paint hints (`ui/paint-hints.ts`) drop every prefetched answer, and
 * derive their event set from this table's keys, so an event added here reaches
 * both and the two lists cannot drift apart.
 *
 * The events are the ones the reading surfaces already reread on: a machine or
 * store moved, a project was saved or removed, the setup check changed, or the
 * connection came back (every answer may have been produced on the lost one).
 */
export const SHARE_INVALIDATION: Readonly<Record<string, (key: string) => boolean>> = {
  connection: () => true,
  storage: (key) => key.startsWith('GET /api/storage') || key.startsWith('GET /api/machines') || key.startsWith('op projects.catalog') || key.startsWith('op sessions.list'),
  'storage-changed': (key) => key.startsWith('GET /api/storage') || key.startsWith('GET /api/machines') || key.startsWith('op projects.catalog') || key.startsWith('op sessions.list'),
  'machine-progress': (key) => key.startsWith('GET /api/machines') || key.startsWith('GET /api/storage') || key.startsWith('op sessions.list'),
  'layerfs-availability': (key) => key.startsWith('GET /api/machines') || key.startsWith('GET /api/storage') || key.startsWith('op sessions.list'),
  'runtime-changed': (key) => key.startsWith('GET /api/machines') || key.startsWith('op setup.status'),
  projects: (key) => key.startsWith('op projects.catalog') || key.startsWith('GET /api/projects'),
  'projects-changed': (key) => key.startsWith('op projects.catalog') || key.startsWith('GET /api/projects'),
  'layerfs-workspaces-changed': (key) => key.startsWith('op projects.catalog') || key.startsWith('op sessions.list'),
  'layerfs-session': (key) => key.startsWith('op sessions.list'),
  'setup-changed': (key) => key.startsWith('op setup.status'),
}
