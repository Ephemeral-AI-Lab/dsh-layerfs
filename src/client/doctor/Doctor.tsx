/**
 * Targeted Doctor (`POST /api/doctor-jobs`): a Diagnose button per resource
 * opens this panel, which launches the job, follows it to its report and lists
 * earlier reports for the same target. A diagnosis has no progress events —
 * while it runs the panel shows its state and elapsed seconds, not a bar.
 * No timeout control: the CLI's per-target budgets are the product defaults.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Checkbox, IconChevronRightOutlineRegular, IconInspectOutlineRegular, Modal, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import type { DoctorT } from './locale.ts'
import css from './Doctor.module.css'

export type DoctorTarget = 'host' | 'machine' | 'sandbox' | 'store.integrity' | 'store.connection' | 'backup.connection'

export interface DoctorRequest {
  target: DoctorTarget
  name?: string | undefined
  quick?: boolean | undefined
  write_test?: boolean | undefined
}

export interface DoctorCheck {
  id: string
  code: string
  outcome: string
  severity?: string | undefined
  message: string
  evidence?: unknown
  blocked_by?: unknown
  fix?: string | undefined
}

export interface DoctorFinding {
  severity: string
  message?: string | undefined
  entity?: unknown
  fix?: string | undefined
}

export interface TargetedReport {
  ok: boolean
  complete: boolean
  target: { kind: string, name: string }
  operation: string
  mode: string
  observed_at_ms: number
  duration_ms: number
  truncated: boolean
  counts: Record<string, unknown>
  findings: DoctorFinding[]
  checks: DoctorCheck[]
}

export type DoctorJobState = 'queued' | 'running' | 'completed' | 'interrupted' | 'failed' | 'unavailable'

export interface DoctorJob {
  id: string
  request: DoctorRequest
  state: DoctorJobState
  created: number
  started?: number | undefined
  ended?: number | undefined
  error?: string | undefined
  simulated?: boolean | undefined
  report?: TargetedReport | undefined
  hasReport?: boolean | undefined
}

const busyState = (state: DoctorJobState | undefined) => state === 'queued' || state === 'running'

const stateKey = { queued: 'stateQueued', running: 'stateRunning', completed: 'stateCompleted', failed: 'stateFailed', interrupted: 'stateInterrupted', unavailable: 'stateUnavailable' } as const

/** A Diagnose button that opens the panel for one target and resource. */
export function DoctorAction({ api, t, target, name, label }: { api: LayerfsApi, t: DoctorT, target: DoctorTarget, name?: string | undefined, label: string }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" icon={<IconInspectOutlineRegular size={13} />} onClick={() => setOpen(true)}>{label}</Button>
      {open ? <DoctorPanel api={api} t={t} target={target} name={name} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function DoctorPanel({ api, t, target, name, onClose }: { api: LayerfsApi, t: DoctorT, target: DoctorTarget, name?: string | undefined, onClose: () => void }): ReactNode {
  const [job, setJob] = useState<DoctorJob | null>(null)
  const [history, setHistory] = useState<DoctorJob[]>([])
  const [quick, setQuick] = useState(false)
  const [writeTest, setWriteTest] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  const [launching, setLaunching] = useState(false)
  const [now, setNow] = useState(Date.now())
  const key = useRef(crypto.randomUUID())
  const busy = launching || busyState(job?.state)

  useEffect(() => {
    void api.call<DoctorJob[]>('GET', '/api/doctor-jobs').then(setHistory, setError)
  }, [api])

  // A diagnosis reports once at the end: poll while it is queued or running,
  // and the host's `doctor` event refetches on each state change.
  useEffect(() => {
    if (!job || !busyState(job.state)) return
    const read = () => void api.call<DoctorJob>('GET', `/api/doctor-jobs/${enc(job.id)}`).then(setJob, setError)
    const off = api.onEvent('doctor', (e) => { if (e.data?.id === job.id) read() })
    const timer = setInterval(() => { setNow(Date.now()); read() }, 1000)
    return () => { off(); clearInterval(timer) }
  }, [api, job?.id, job?.state])

  const launch = async () => {
    setLaunching(true)
    setError(undefined)
    try {
      const request: DoctorRequest = { target, ...(name ? { name } : {}), ...(target === 'store.integrity' ? { quick } : {}), ...(target === 'backup.connection' ? { write_test: writeTest } : {}) }
      const next = await api.call<DoctorJob>('POST', '/api/doctor-jobs', { ...request, key: key.current })
      setJob(next)
      key.current = crypto.randomUUID()
    } catch (e) {
      setError(e)
    } finally {
      setLaunching(false)
    }
  }

  const recent = history.filter((j) => j.request.target === target && j.request.name === name && j.id !== job?.id)
  return (
    <Modal open onClose={onClose} title={t('panelTitle', { name: name ?? t('thisHost') })} description={t('panelBody', { target })} closeLabel={t('close')} className={css.modal}
      footer={(
        <Button variant="primary" disabled={busy} aria-busy={busy} icon={busy ? <StateDot state="ongoing" size={13} /> : undefined} onClick={() => { void launch() }}>
          {busy ? t('diagnosing') : t('runDiagnosis')}
        </Button>
      )}>
      <div className={css.body}>
        {target === 'store.integrity' ? <Checkbox className={css.option} checked={quick} disabled={busy} onChange={setQuick} label={t('quickIntegrity')} /> : null}
        {target === 'backup.connection' ? <Checkbox className={css.option} checked={writeTest} disabled={busy} onChange={setWriteTest} label={t('writeTest')} /> : null}
        {error !== undefined ? <p className={css.jobError} role="alert">{error instanceof Error ? error.message : String(error)}</p> : null}
        {job ? <JobView job={job} t={t} now={now} /> : null}
        {recent.length > 0 ? (
          <details className={css.history}>
            <summary>{t('previousReports', { n: recent.length })}</summary>
            <p className={css.meta}>{t('previousNote')}</p>
            <ul className={css.historyList}>
              {recent.map((j) => (
                <li key={j.id}>
                  <button type="button" className={css.historyItem} onClick={() => void api.call<DoctorJob>('GET', `/api/doctor-jobs/${enc(j.id)}`).then(setJob, setError)}>
                    {new Date(j.created).toLocaleString()} · {j.request.quick ? 'quick' : j.request.write_test ? 'write-test' : j.request.target} · {t(stateKey[j.state])}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </Modal>
  )
}

function JobView({ job, t, now }: { job: DoctorJob, t: DoctorT, now: number }): ReactNode {
  const running = busyState(job.state)
  const elapsed = running && job.started ? Math.max(0, Math.floor((now - job.started) / 1000)) : null
  return (
    <div className={css.job}>
      <p className={css.jobState}>
        {running ? <StateDot state="ongoing" size={12} /> : null}
        <span>{t(stateKey[job.state])}{elapsed !== null ? ` · ${t('elapsed', { s: elapsed })}` : ''}</span>
      </p>
      {job.error ? <p className={css.jobError} role="alert">{job.error}</p> : null}
      {job.simulated ? <p className={css.simulated} role="status">{t('simulated')}</p> : null}
      {job.report ? <DoctorReport report={job.report} t={t} /> : null}
    </div>
  )
}

/** A targeted report's verdict, coverage, findings and checks, as the SDK gave them. */
export function DoctorReport({ report, t }: { report: TargetedReport, t: DoctorT }): ReactNode {
  const errors = report.ok === false || report.findings.some((f) => f.severity === 'error') || report.checks.some((c) => c.outcome === 'fail' && c.severity === 'error')
  const verdict = errors
    ? (report.complete ? t('verdictIssues') : t('verdictIssuesIncomplete'))
    : !report.complete
      ? t('verdictIncomplete')
      : report.findings.length ? t('verdictWarnings') : t('verdictClean')
  const coverage = report.complete ? t('coverageComplete') : t('coverageIncomplete')
  const checks = report.checks.map((check, index) => ({ check, index }))
    .sort((a, b) => Number(['pass', 'skipped'].includes(a.check.outcome)) - Number(['pass', 'skipped'].includes(b.check.outcome)))
  return (
    <>
      <p className={css.verdict} role="status">{verdict}</p>
      <p className={css.meta}>{t('observedLine', { mode: report.mode, time: new Date(report.observed_at_ms).toLocaleString(), ms: report.duration_ms })}</p>
      <p className={css.meta}>{t('coverageLine', { n: report.findings.length, coverage })}{report.truncated ? ` · ${t('coverageTruncated')}` : ''}</p>
      <p className={css.meta}>{t('reportedCounts', { counts: JSON.stringify(report.counts) })}</p>
      {report.findings.length > 0 ? (
        <div className={css.section} aria-label={t('findings')}>
          {report.findings.map((f, i) => (
            <div key={i} className={css.row}>
              <span className={css.rowTop}>
                <Tag tone={f.severity === 'error' ? 'danger' : 'warning'}>{f.severity}</Tag>
                {f.entity != null ? <span className={css.rowEntity}>{typeof f.entity === 'object' ? JSON.stringify(f.entity) : String(f.entity)}</span> : null}
              </span>
              <span>{f.message ?? ''}</span>
              {f.fix ? <span className={css.code}>{t('suggestedAction', { fix: f.fix })}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
      {checks.length > 0 ? (
        <div className={css.section} aria-label={t('checks')}>
          {checks.map(({ check, index }) => (
            <details key={`${check.id}:${index}`} className={`${css.row} ${css.check}`}>
              <summary>
                <IconChevronRightOutlineRegular size={12} className={css.checkChevron} aria-hidden="true" />
                <Tag tone={check.outcome === 'fail' ? 'danger' : check.outcome === 'pass' ? 'success' : check.outcome === 'skipped' ? 'quiet' : 'warning'}>{check.outcome}{check.severity ? ` / ${check.severity}` : ''}</Tag>
                <span>{check.message}</span>
              </summary>
              <div className={css.checkBody}>
                <code className={css.code}>{check.code}</code>
                {check.blocked_by != null ? <span>{t('dependencies', { deps: JSON.stringify(check.blocked_by) })}</span> : null}
                {check.evidence != null ? <pre className={css.evidence}>{JSON.stringify(check.evidence, null, 2)}</pre> : null}
                {check.fix ? <span>{t('suggestedAction', { fix: check.fix })}</span> : null}
              </div>
            </details>
          ))}
        </div>
      ) : null}
    </>
  )
}
