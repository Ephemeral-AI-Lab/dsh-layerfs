/**
 * Blame: each line of a saved file with the saved version that last wrote it.
 * Consecutive lines from one version form a group, labeled once; the newest
 * version is marked, and a version saved on another Branch says which.
 * Selecting a group opens that version's change in History.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { filesApi } from './api.ts'
import { ago, shortId, toMs, when } from './format.ts'
import { approximateNote, ownerTitle, revisionTitle } from './labels.ts'
import { EmptyState, ErrorState, Loading } from './States.tsx'
import type { BlameResult, LineOwner, Translate } from './types.ts'
import { errorCode, useQuery } from './use-query.ts'
import css from './Files.module.css'

export interface FileBlameProps {
  api: LayerfsApi
  project: string
  branch: string
  path: string
  pin?: string | undefined
  t: Translate
  /** Opens a version (its saved id) in the file's History. */
  onInspect: (version: string) => void
}

interface Group { owner: LineOwner | null, lines: BlameResult['lines'] }

export function FileBlame({ api, project, branch, path, pin, t, onInspect }: FileBlameProps): ReactNode {
  const first = useQuery(() => filesApi.blame(api, project, branch, path, pin), [api, project, branch, path, pin])
  // The file's versions carry the times blame does not; a refusal only drops the times.
  const versions = useQuery(() => filesApi.revisions(api, project, branch, path, pin, 'provenance').catch(() => null), [api, project, branch, path, pin])
  const [more, setMore] = useState<BlameResult[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  useEffect(() => { setMore([]) }, [first.data])
  const times = useMemo(() => new Map((versions.data?.items ?? []).map((v) => [v.ref.id, toMs(v.recorded_at)])), [versions.data])
  // A version's title as History names it (e.g. Initial import), else its message.
  const titles = useMemo(() => new Map((versions.data?.items ?? []).map((v) => [v.ref.id, revisionTitle(v, t)])), [versions.data, t])

  if (first.error) {
    const code = errorCode(first.error)
    if (code === 'NoSuchPath') return <EmptyState title={t('files_absent')} />
    return <ErrorState title={t('files_readFailed', { what: path })} error={first.error} retryLabel={t('files_retry')} onRetry={first.reload} />
  }
  if (!first.data) return <Loading label={t('files_blameReading')} className={css.pad} />
  const windows = [first.data, ...more]
  const lines = windows.flatMap((w) => w.lines)
  const next = windows.at(-1)?.next_line ?? null
  const groups: Group[] = []
  for (const line of lines) {
    const last = groups.at(-1)
    if (last && last.owner?.ref.id === line.owner?.ref.id) last.lines.push(line)
    else groups.push({ owner: line.owner, lines: [line] })
  }
  // The newest version that wrote a shown line, when the versions carry times.
  let newest: string | undefined
  let newestAt = -Infinity
  for (const g of groups) {
    const at = g.owner ? times.get(g.owner.ref.id) : null
    if (g.owner && at != null && at > newestAt) { newest = g.owner.ref.id; newestAt = at }
  }
  const note = windows.map((w) => approximateNote(w.coverage, w.comparison_coarse, t)).find(Boolean)
  const now = Date.now()
  const loadMore = () => {
    if (next == null) return
    setLoadingMore(true)
    filesApi.blame(api, project, branch, path, pin, next).then((w) => setMore((m) => [...m, w]), () => undefined).finally(() => setLoadingMore(false))
  }
  if (!lines.length) return <EmptyState title={t('files_diffNoContent')} />
  return (
    <div className={css.fileBody}>
      {note ? <p className={css.fileNote}>{note}</p> : null}
      <div className={css.blame} role="table" aria-label={t('files_modeBlame')}>
        {groups.map((g, i) => {
          const owner = g.owner
          const at = owner ? times.get(owner.ref.id) : null
          const other = owner?.ref.branch && owner.ref.branch !== branch ? owner.ref.branch : null
          const title = owner ? owner.message || titles.get(owner.ref.id) || ownerTitle(owner, t) : ''
          return (
            <div key={`${i}:${owner?.ref.id ?? 'unknown'}`} className={css.blameGroup} role="row" data-newest={owner && owner.ref.id === newest ? '' : undefined}>
              <div className={css.blameOwnerCell} role="cell">
                {owner ? (
                  <button type="button" className={css.blameOwner} onClick={() => onInspect(owner.ref.id)}
                    aria-label={t('files_blameInspect', { id: shortId(owner.ref.id) })} title={`${title}\n${owner.ref.id}${at != null ? `\n${when(at)}` : ''}`}>
                    <span className={css.blameMessage}>{title}</span>
                    <span className={css.blameMeta}>
                      <code>{shortId(owner.ref.id)}</code>
                      {at != null ? <span>{ago(at, now, t)}</span> : null}
                      {other ? <span>{t('files_blameFrom', { branch: other })}</span> : null}
                    </span>
                  </button>
                ) : <span className={css.blameUnknown}>{t('files_blameUnknown')}</span>}
              </div>
              <div className={css.blameLines} role="cell">
                {g.lines.map((line) => (
                  <div key={line.n} className={css.blameLine}>
                    <span className={css.blameNumber}>{line.n}</span>
                    <code className={css.blameText}>{line.text || ' '}</code>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <div className={css.fileFoot}>
        <span>{t('files_blameHint')}</span>
        {next != null ? <Button variant="outline" size="sm" disabled={loadingMore} onClick={loadMore}>{t('files_blameMore')}</Button> : null}
      </div>
      {lines.some((l) => l.line_truncated || l.clipped) ? <p className={css.fileNote}>{t('files_lineClipped')}</p> : null}
    </div>
  )
}
