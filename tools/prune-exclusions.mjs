// What the prune tool keeps beside the host's own keep list. Reading DSH's
// archive set here also covers a host process that predates the host-side
// default (the running 3090 server is not restarted for a tool run).
//
// The answer handling lives here too, so the tool's old-host behaviour is
// testable without a browser: a host that cannot name its archive set still
// answers a dry run (the ids read above are already in `current`), but refuses
// `--apply`; the tool reports that and asks for a restart, never retrying.
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

/**
 * The process exit code and the one honest line for a host answer. A host that
 * cannot verify DSH's archive set (`archiveKnown: false`) is allowed to answer
 * this tool's dry run, because the ids from `archivedSessionIds()` are already
 * in `current`; its `--apply` refusal is not retried and not reported as a
 * generic failure: the host cannot prove the keep list is complete.
 * @param {{ apply: boolean, result: any }} answer - the tool's request and the page's answer.
 * @returns {{ exitCode: number, note: string }} what to print on stderr.
 */
export function pruneOutcome({ apply, result }) {
  const count = (ids) => Array.isArray(ids) ? ids.length : 0
  if (!result?.ok) {
    const unknown = result?.detail?.reason === 'archive-unknown' || result?.detail?.archiveKnown === false
    return {
      exitCode: 1,
      note: unknown
        ? 'refused: this host cannot verify DSH\'s archive set, so --apply deleted nothing. This tool keeps the file-based archive ids, but only the host can prove the set is complete; restart DSH so workspaceRegistry.archivedSessionIds exists, then run again.'
        : `refused (${result?.code ?? 'error'}): ${result?.message ?? 'no message'}`,
    }
  }
  if (apply) return { exitCode: 0, note: `deleted ${count(result.deleted)} conversation(s).` }
  if (result.archiveKnown === false) {
    return {
      exitCode: 0,
      note: `dry run: ${count(result.candidates)} candidate(s), nothing deleted; this host cannot verify DSH\'s archive set, so --apply is refused until DSH restarts.`,
    }
  }
  return { exitCode: 0, note: `dry run: ${count(result.candidates)} candidate(s), nothing deleted. Re-run with --apply to delete them.` }
}
