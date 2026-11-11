/**
 * A project's saved-revision storage analysis (LayerFS Connect's
 * `components/storage/{ProjectStorage,StorageHistory,SavedRevisionAnalysis}`):
 * the latest main snapshot, saved file size Commit by Commit with a revision
 * inspector, and the on-demand canonical-reuse analysis drawn as a staged
 * flow with its reuse ring.
 */
import { useState, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import type { CommitInfo } from '../files/types.ts'
import { shortId, when } from '../files/format.ts'
import { useQuery } from '../files/use-query.ts'
import { LinkButton, LoadError, Loading, MenuSelect } from '../ui/index.tsx'
import { exactBytes, exactCount } from './exact-count.ts'
import type { StorageT } from './locale.ts'
import { coordinate, integer, maximum } from './measures.ts'
import { refusalLabels } from './parts.tsx'
import { MeasurementLine, MeasuredValue, ReuseRing, StagedStorageFlow, ratioStep, type StorageStage } from './StorageVisuals.tsx'
import type { ProjectState, ProjectTreeStats, StorageHistoryPage, StorageReport } from './types.ts'
import css from './StorageVisuals.module.css'

export interface ProjectStorageProps {
  api: LayerfsApi
  t: StorageT
  /** GET /api/projects/<key>. */
  state: ProjectState
  /** Opens the owning Store's page. */
  onOpenStore: (store: string) => void
}

export function ProjectStorage({ api, t, state, onOpenStore }: ProjectStorageProps): ReactNode {
  const project = state.project.key
  const pin = state.branches.find((b) => b.name === 'main')?.head
  return (
    <div className={css.dashboard}>
      <StorageHistory key={project} api={api} t={t} project={project} branches={state.branches} pin={pin} />
      <footer className={css.scopeFooter}>
        <span>{t('storeAllocationNote')}</span>
        <LinkButton onClick={() => onOpenStore(state.project.store)}>{t('viewStoreUsage')}</LinkButton>
      </footer>
    </div>
  )
}

function StorageHistory({ api, t, project, branches, pin }: {
  api: LayerfsApi
  t: StorageT
  project: string
  branches: { name: string, head: string | null }[]
  pin?: string | null
}): ReactNode {
  const [branch, setBranch] = useState('main')
  const [size, setSize] = useState('20')
  const selectedPin = branch === 'main' ? pin : branches.find((b) => b.name === branch)?.head
  const names = Array.from(new Set(['main', ...branches.map((b) => b.name)]))
  return (
    <section className={css.analysis} aria-label={t('storageTitle')}>
      <div className={css.dashboardHeader}>
        <div>
          <h2>{t('storageTitle')}</h2>
          <p className={css.note}>{t('storageSubtitle', { project })}</p>
        </div>
        <div className={css.toolbar}>
          <label>{t('branchLabel')}
            <MenuSelect value={branch} label={t('branchAria')} onChange={setBranch}
              options={names.map((name) => ({ value: name, label: name }))} />
          </label>
          <MenuSelect value={size} label={t('rangeAria')} onChange={setSize}
            options={[{ value: '10', label: t('range10') }, { value: '20', label: t('range20') }]} />
        </div>
      </div>
      <MainSnapshotSummary key={`${project}:main:${pin}`} api={api} t={t} project={project} pin={pin} />
      <History key={`${project}:${branch}:${selectedPin}:${size}`} api={api} t={t} project={project} branch={branch} pin={selectedPin} size={Number(size)} />
    </section>
  )
}

function History({ api, t, project, branch, pin, size }: {
  api: LayerfsApi
  t: StorageT
  project: string
  branch: string
  pin?: string | null
  size: number
}): ReactNode {
  const path = `/api/projects/${enc(project)}/storage-history?branch=${enc(branch)}&size=${size}`
  const q = useQuery(() => api.call<StorageHistoryPage>('GET', `${path}${pin ? `&at=${enc(pin)}` : ''}`), [api, path, pin])
  const [older, setOlder] = useState<CommitInfo[]>([])
  const [next, setNext] = useState<string | null | undefined>()
  const [selected, setSelected] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>()
  const page = q.data
  if (q.error) return <LoadError title={t('historyFailed')} error={q.error} labels={refusalLabels(t)} retryLabel={t('retry')} onRetry={q.reload} />
  if (!page) return <Loading label={t('readingHistory')} />
  const rows = [...new Map([...page.items, ...older].map((item) => [item.id, item])).values()].reverse()
  const cursor = next === undefined ? page.next : next
  const maxAdded = maximum(rows.map((c) => c.savedKind === 'commit' ? c.newStored : null))
  const active = rows.find((row) => row.id === selected) ?? rows.at(-1)
  async function loadEarlier() {
    if (!cursor || loading) return
    setLoading(true)
    setError(undefined)
    try {
      const result = await api.call<StorageHistoryPage>('GET', `${path}&at=${enc(cursor)}`)
      setOlder((items) => [...items, ...result.items])
      setNext(result.next)
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }
  return (
    <>
      <SavedRevisionAnalysis key={`reuse:${project}:${branch}:${page.head?.id ?? 'empty'}:${size}`} api={api} t={t} project={project} branch={branch} pin={page.head?.id ?? null} size={size} />
      <div className={css.inspectionGrid}>
        <div className={css.chartHero}>
          <div className={css.heading}>
            <div>
              <h3>{t('savedFileSize')}</h3>
              <p className={css.note}>{t('savedRevisionsMeta', { branch, n: rows.length })}</p>
            </div>
            <div className={css.latest}>
              <span>{t('latestSavedSize')}</span>
              <strong><MeasuredValue value={rows.at(-1)?.logical} bytes /></strong>
            </div>
          </div>
          {rows.length ? (
            <>
              <MeasurementLine t={t} values={rows.map((row) => row.logical)} points={rows.map((row) => shortId(row.id))}
                label={t('savedSizeAria')} selectedIndex={rows.findIndex((row) => row.id === active?.id)}
                onSelect={(index) => setSelected(rows[index].id)} />
              <div className={css.saveHeading}>
                <span>{t('newStoredPerSave')}</span>
                <span>{rows.some((row) => row.savedKind === 'commit' && integer(row.newStored) !== null)
                  ? t('separateScale', { bytes: exactBytes(maxAdded <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(maxAdded) : { $layerfs: 'i64-v1', decimal: maxAdded.toString() }) })
                  : t('additionsUnavailable')}</span>
              </div>
              <div className={css.saveBars} aria-label={t('saveBarsAria')}>
                {rows.map((c, index) => {
                  const available = c.savedKind === 'commit' && integer(c.newStored) !== null
                  return (
                    <button key={c.id} type="button"
                      aria-label={t('inspectRevisionBytes', { id: shortId(c.id), bytes: available ? exactBytes(c.newStored) : t('bytesUnavailable') })}
                      aria-pressed={active?.id === c.id}
                      className={css.saveSlot}
                      style={{ left: `${rows.length === 1 ? 50 : (8 + index / (rows.length - 1) * 584) / 6}%`, width: `min(28px, ${85 / rows.length}%)` }}
                      onClick={() => setSelected(c.id)}>
                      <span className={css.saveBar} data-missing={!available} style={{ height: `${Math.max(2, (available ? coordinate(c.newStored, maxAdded) ?? 0 : 0) * 100)}%` }} />
                    </button>
                  )
                })}
              </div>
              <div className={css.chartEnds}><span>{shortId(rows[0].id)}</span><span>{shortId(rows.at(-1)!.id)}</span></div>
              <p className={css.note}>{t('selectPointHint')}</p>
            </>
          ) : <p className={css.note}>{t('noRevisions')}</p>}
          {error ? <LoadError title={t('earlierFailed')} error={error} labels={refusalLabels(t)} retryLabel={t('retry')} onRetry={loadEarlier} /> : null}
          {cursor ? (
            <Button variant="outline" size="sm" className={css.loadEarlier} disabled={loading}
              icon={loading ? <StateDot state="ongoing" size={13} /> : undefined}
              onClick={loadEarlier}>{loading ? t('loadingEarlier') : t('loadEarlier')}</Button>
          ) : null}
        </div>
        {active ? <RevisionInspector key={`inspector:${active.id}`} api={api} t={t} project={project} branch={branch} revision={active} rows={rows} onSelect={setSelected} /> : null}
      </div>
      {rows.length > 0 ? (
        <details className={css.measureDetails}>
          <summary>{t('exactMeasurements', { n: rows.length })}</summary>
          <table className={css.measureTable}>
            <thead><tr><th>{t('colRevision')}</th><th>{t('colSavedSize')}</th><th>{t('colNewCanonical')}</th><th>{t('colNewStored')}<small>{t('metadataIncluded')}</small></th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td><button type="button" className={css.tableLink} onClick={() => setSelected(row.id)} title={row.id}>{shortId(row.id)}</button><small>{row.savedKind === 'layer' ? t('kindPublication') : t('kindCommit')}</small></td>
                  <td>{exactBytes(row.logical)}</td>
                  <td>{exactBytes(row.newCanonical)}</td>
                  <td>{exactBytes(row.newStored)}<small>{t('metadataOf', { bytes: exactBytes(row.newMetadata) })}</small></td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
      <details className={css.measureDetails}>
        <summary>{t('howMeasured')}</summary>
        <p className={css.note}>{t('howMeasuredBody', { size })}</p>
      </details>
    </>
  )
}

function RevisionInspector({ api, t, project, branch, revision, rows, onSelect }: {
  api: LayerfsApi
  t: StorageT
  project: string
  branch: string
  revision: CommitInfo
  rows: CommitInfo[]
  onSelect: (id: string) => void
}): ReactNode {
  const q = useQuery(() => api.call<ProjectTreeStats>('GET', `/api/projects/${enc(project)}/stats?branch=${enc(branch)}&pin=${enc(revision.id)}`), [api, project, branch, revision.id])
  const s = q.data?.projectKey === project && q.data.at.id === revision.id ? q.data : undefined
  const at = when(revision.at)
  return (
    <aside className={css.inspector} aria-label={t('selectedRevision')}>
      <div className={css.heading}><h3>{t('selectedRevision')}</h3><span className={css.kind}>{revision.savedKind === 'layer' ? t('kindPublication') : t('kindCommit')}</span></div>
      <MenuSelect value={revision.id} label={t('selectedRevisionAria')} onChange={onSelect}
        options={rows.map((row) => ({ value: row.id, label: `${shortId(row.id)}${row.id === rows.at(-1)?.id ? t('latestSuffix') : ''}` }))} />
      <p className={css.revisionMessage}>{revision.message || t('savedRevisionFallback')}</p>
      <p className={css.note}>{branch} · {at ?? t('saveTimeUnavailable')}</p>
      <dl className={css.inspectorFacts}><div><dt>{t('colSavedSize')}</dt><dd>{exactBytes(revision.logical)}</dd></div></dl>
      {q.error
        ? <LoadError title={t('entryCountsFailed')} error={q.error} labels={refusalLabels(t)} retryLabel={t('retry')} onRetry={q.reload} />
        : !s
          ? <Loading label={t('countingEntries')} />
          : (
            <>
              <dl className={css.inspectorFacts}>
                {([[t('files'), s.files], [t('directories'), s.directories], [t('symlinks'), s.symlinks], [t('otherEntries'), s.others]] as [string, unknown][]).map(([label, value]) => (
                  <div key={label}><dt>{label}</dt><dd>{exactCount(value)}</dd></div>
                ))}
              </dl>
              {!s.complete ? <p className={css.note} role="status">{t('partialCounts', { reason: s.reason ?? t('budgetReached') })}</p> : null}
            </>
          )}
      <div className={css.saveFacts}>
        <h4>{t('saveAdded')}</h4>
        <dl className={css.inspectorFacts}>
          <div><dt>{t('newUniqueCanonical')}</dt><dd>{exactBytes(revision.newCanonical)}</dd></div>
          <div><dt>{t('storedObjects')}</dt><dd>{exactBytes(revision.newStored)}</dd></div>
          <div><dt>{t('metadataIncludedAbove')}</dt><dd>{exactBytes(revision.newMetadata)}</dd></div>
        </dl>
        {revision.savedKind === 'layer' ? <p className={css.note}>{t('publicationNoAdds')}</p> : null}
      </div>
    </aside>
  )
}

function MainSnapshotSummary({ api, t, project, pin }: { api: LayerfsApi, t: StorageT, project: string, pin?: string | null }): ReactNode {
  const q = useQuery(() => api.call<ProjectTreeStats>('GET', `/api/projects/${enc(project)}/stats?branch=main${pin ? `&pin=${enc(pin)}` : ''}`), [api, project, pin])
  const s = q.data?.projectKey === project && (!pin || q.data.at.id === pin) ? q.data : undefined
  return (
    <section className={css.mainSummary} aria-label={t('latestMainSnapshot')}>
      <div><span className={css.mainBadge}>{t('mainBadge')}</span><span>{t('latestMainSnapshot')}</span>{s ? <code title={s.at.id}>{shortId(s.at.id)}</code> : null}</div>
      {q.error
        ? <LoadError title={t('snapshotFailed')} error={q.error} labels={refusalLabels(t)} retryLabel={t('retry')} onRetry={q.reload} />
        : !s
          ? <Loading label={t('readingSnapshot')} />
          : (
            <>
              <strong><MeasuredValue value={s.logical} bytes /></strong>
              <span>{t('snapshotCounts', { files: exactCount(s.files), dirs: exactCount(s.directories) })}{s.complete ? '' : ` · ${t('partialEntryCounts')}`}</span>
            </>
          )}
    </section>
  )
}

// ---------- canonical reuse analysis ----------

type CanonicalReport = Omit<StorageReport, 'selection'>

export function SavedRevisionAnalysis({ api, t, project, branch, pin, size = 20 }: {
  api: LayerfsApi
  t: StorageT
  project: string
  branch: string
  pin: string | null
  size?: number
}): ReactNode {
  const [requested, setRequested] = useState(false)
  const q = useQuery(async () => {
    if (!pin || !requested) return undefined
    const result = await api.call<StorageReport>('GET', `/api/projects/${enc(project)}/storage-report?branch=${enc(branch)}&at=${enc(pin)}&size=${size}`)
    if (result.scope !== 'project' || result.project !== project) throw new Error(t('analysisMismatch'))
    return result
  }, [api, project, branch, pin, size, requested])
  const report = q.data
  const busy = requested && q.loading && !!pin
  const error = busy ? undefined : q.error
  const analyze = () => { if (requested) q.reload(); else setRequested(true) }
  return (
    <div className={`${css.analysisPanel} ${css.efficiencyHero}`}>
      <div className={css.heading}>
        <h3>{t('analysisTitle')}</h3>
        <Button variant="outline" size="sm" onClick={analyze} disabled={!pin || busy}
          icon={busy ? <StateDot state="ongoing" size={13} /> : undefined}>
          {busy ? t('analyzing') : report ? t('analyzeAgain') : error ? t('retryAnalysis') : t('analyzeRevisions')}
        </Button>
      </div>
      <p className={css.note}>{t('analysisProject', { project })}</p>
      {!requested && pin ? <p className={css.note}>{t('analyzeHint', { n: size })}</p> : null}
      {!pin ? <p className={css.note}>{t('noRevisionsToAnalyze', { branch })}</p> : null}
      {busy ? <Loading label={t('analyzingLabel')} /> : null}
      {error ? <LoadError title={t('analysisFailed')} error={error} labels={refusalLabels(t)} retryLabel={t('retry')} onRetry={analyze} /> : null}
      {report && !busy && !error ? (
        <>
          <p className={css.note}>
            {t('reportMeta', { n: report.snapshots.length, branch, pin: pin ? shortId(pin) : t('pinnedNone') })}
            {report.selection.hasEarlier ? ` · ${t('reportEarlier')}` : ''} · {report.complete ? t('reportComplete') : t('reportIncomplete')}
          </p>
          <CanonicalReportResult report={report} t={t} />
        </>
      ) : null}
    </div>
  )
}

export function CanonicalReportResult({ report, t }: { report: CanonicalReport, t: StorageT }): ReactNode {
  const complete = report.definition_version === 1 && report.population === 'explicit_saved_snapshots' && report.complete && report.referenced_canonical_bytes !== null && report.unique_canonical_bytes !== null
  const payload = report.payload_encoding
  const payloadComplete = complete && payload?.definition_version === 1 && payload.population === 'selected_payload_object_records' && payload.available && payload.referenced_canonical_bytes !== null && payload.unique_canonical_bytes !== null && payload.encoded_record_bytes !== null && payload.dependency_closure_included === false && payload.shared_framing_included === false
  const referenced = payloadComplete ? payload.referenced_canonical_bytes : report.referenced_canonical_bytes
  const unique = payloadComplete ? payload.unique_canonical_bytes : report.unique_canonical_bytes
  const stages: StorageStage[] = [
    { label: t('stageReferenced'), caption: t('stageReferencedCaption'), value: referenced, tone: 'referenced' },
    { label: t('stageUnique'), caption: t('stageUniqueCaption'), value: unique, tone: 'canonical' },
    ...(payloadComplete ? [{ label: t('stageEncoded'), caption: t('stageEncodedCaption'), value: payload.encoded_record_bytes, tone: 'stored' as const }] : []),
  ]
  const steps = [
    ratioStep(t, referenced, unique, t('dedupeLabel')),
    ...(payloadComplete ? [ratioStep(t, unique, payload.encoded_record_bytes, t('encodingLabel'))] : []),
  ]
  return (
    <>
      {complete ? (
        <div className={css.populationEfficiency}>
          <div className={css.efficiencySummary}>
            <div>
              <h4>{payloadComplete ? t('dedupeCompression') : t('canonicalDedupe')}</h4>
              <p className={css.note}>{payloadComplete ? t('payloadObjects') : t('snapshotObjects')}</p>
            </div>
            <ReuseRing referenced={referenced} unique={unique} t={t} />
          </div>
          <StagedStorageFlow stages={stages} steps={steps} label={payloadComplete ? t('flowLabelDedupeEncoding') : t('flowLabelDedupe')} t={t} />
        </div>
      ) : (
        <p className={css.note} role="status">{t('populationIncompleteBody', { reason: report.reason ?? t('populationUnmeasurable') })}</p>
      )}
      {payloadComplete
        ? <p className={css.note}>{t('payloadNote')}</p>
        : <p className={css.note}>{payload?.reason ?? t('payloadUnavailable')}</p>}
      <details className={css.measureDetails}>
        <summary>{t('howAnalysisMeasured')}</summary>
        <p className={css.note}>{t('analysisMeasuredBody', { referenced: exactBytes(report.referenced_canonical_bytes), unique: exactBytes(report.unique_canonical_bytes) })}</p>
        {payloadComplete ? <p className={css.note}>{t('deltaBasesBody', { count: exactCount(payload.external_direct_base_count) })}</p> : null}
        <p className={css.note}>{t('examinedBody', { objects: exactCount(report.examined_objects), bytes: exactBytes(report.canonical_bytes_read) })}</p>
      </details>
      <details className={css.measureDetails}>
        <summary>{t('analysisScope')}</summary>
        <p className={css.note}>{t('physicalBody', { physical: exactBytes(report.physical_bytes), reclaimable: exactBytes(report.reclaimable_bytes), reason: report.physical_reason })}</p>
        <ul className={css.analysisPins}>
          {report.snapshots.map((snapshot) => (
            <li key={`${snapshot.project}:${snapshot.branch}:${snapshot.at.id}`}>
              <span>{snapshot.project} · {snapshot.branch}</span>
              <code title={snapshot.at.id}>{shortId(snapshot.at.id)}</code>
            </li>
          ))}
        </ul>
      </details>
    </>
  )
}
