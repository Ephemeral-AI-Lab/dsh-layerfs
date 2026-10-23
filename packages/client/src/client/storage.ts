// What the LayerFS pages say about a project's Store (api.projectStorage):
// its size on the status bar, and the figures the view's storage panel draws.
import type { ProjectState, Storage } from './api.ts'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** Bytes in the largest unit under 1000, to three significant digits: as the view's storage panel counts them. */
export function bytes(n: number) {
  let value = n, unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) { value /= 1000; unit++ }
  return unit === 0 ? `${n} B` : `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${UNITS[unit]}`
}

/** ×n, to one decimal below 10. */
export const times = (n: number) => `×${n.toFixed(n >= 10 ? 0 : 1)}`

/** How many times over the Store's file the history's plain files would fill; null when it saves nothing. */
export function saved(z: Storage) {
  const n = z.store.file > 0 ? z.store.logical / z.store.file : 0
  return n > 1 ? n : null
}

/**
 * store.stats for the board: the Store totals, one plain copy of main's head
 * (its source Commit's logical size; null when main is the Init Layer or that
 * Commit is not among the recent ones), the empty Store's baseline, the
 * project's counts, and what each recent Commit added, oldest first.
 */
export function storeOf(storage: Storage, state: ProjectState, lines: any[] = []) {
  const z = storage.store, s = state.s
  const realOf = (label: string | null | undefined) => (label ? Object.keys(state.labels).find((real) => state.labels[real] === label) ?? null : null)
  const layer = s.layers?.[s.main?.head], source = realOf(layer?.sourceCommit)
  // Commits this session's calls made (their trace lines), with the ones the snapshot lists:
  // a retired Branch's Commits are no longer listed
  const made = new Map<string, number | null>()
  for (const line of lines) {
    if (!line.ok || line.phase === 'start') continue
    if (line.commit && line.sizes) made.set(line.commit, line.sizes.logical ?? null)
    else if (line.method === 'branch.merge' && line.head && !made.has(line.head)) made.set(line.head, null)
  }
  const commits = new Set([...Object.keys(state.labels).filter((real) => /^C\d+$/.test(state.labels[real])), ...made.keys()])
  // main's size: the snapshot's own figure for the Layer, else the Commit it was published from, else what Init imported
  const head = layer?.logical ?? (source ? storage.commits.find((c) => c.id === source)?.logical ?? made.get(source) ?? null : s.main?.head === "L0" && layer ? storage.init?.bytes ?? null : null)
  return {
    logical: z.logical, payload: z.canonical, stored: z.stored, metadata: z.metadata, store: z.file, estimate: false,
    head, baseline: storage.init ? storage.init.metadata + storage.init.stored : null, imported: storage.init?.files ?? 0,
    counts: { commits: commits.size, branches: Object.keys(s.branches ?? {}).length, layers: Object.keys(s.layers ?? {}).length },
    perCommit: storage.commits.slice().reverse().map((c) => ({ via: c.via, bytes: c.newStored + c.newMetadata, label: state.labels[c.id] ?? null, message: c.message })),
  }
}
