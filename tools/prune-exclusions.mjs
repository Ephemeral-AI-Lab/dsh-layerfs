// What the prune tool keeps beside the host's own keep list. Reading DSH's
// archive set here also covers a host process that predates the host-side
// default (the running 3090 server is not restarted for a tool run).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH's archived conversation ids, or [] when the workspace store is missing or unreadable. */
export function archivedSessionIds(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  try {
    const state = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
    const ids = state?.global?.archivedSessionIds
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : []
  } catch { return [] }
}

/** The op's `current` keep set: the open conversation plus every archived and explicitly excluded id. */
export function keepSet(selected, archived = [], exclude = []) {
  return [...new Set([...(selected ? [selected] : []), ...archived, ...exclude].filter((id) => typeof id === 'string' && id))]
}
