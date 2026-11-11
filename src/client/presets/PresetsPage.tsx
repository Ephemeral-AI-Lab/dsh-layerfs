/**
 * The Presets page: the Studio library, its execution mode, Build projects
 * and Reset (both confirmed against a fresh inventory plan), the running
 * job's progress and log, and the CLI script drawer. Reads poll every 2 s
 * while a job runs and every 5 s otherwise, and again on `demo-preset`
 * events. A lost answer is reconciled by request ID, never resubmitted.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconCodeOutlineRegular, IconPlayOutlineRegular, IconRefreshOutlineRegular, Modal, SegmentedControl, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import type { BusySession, DemoPreset, DemoPresets, EnvironmentResetPlan, PresetExecutionMode, PresetJob } from '../../shared/presets.ts'
import { useQuery } from '../files/use-query.ts'
import { Card, LinkButton, LoadError, Loading, Notice, Page, PageHead, Refusal } from '../ui/index.tsx'
import { refusalLabels } from './labels.ts'
import type { PresetsT } from './locale.ts'
import { PresetProgress } from './Progress.tsx'
import { ScriptDrawer } from './ScriptDrawer.tsx'
import { PresetTopology, type PresetResource } from './Topology.tsx'
import css from './presets.module.css'

type Confirmation = { build: boolean, sandboxes: boolean, executionMode: PresetExecutionMode, plan: EnvironmentResetPlan }
const running = (job: PresetJob | null | undefined) => job?.state === 'queued' || job?.state === 'running'
const sessionsOf = (error: unknown): BusySession[] => {
  const list = (error as { detail?: { sessions?: unknown } } | null)?.detail?.sessions
  return Array.isArray(list) ? list as BusySession[] : []
}

export function PresetsPage({ api, t }: { api: LayerfsApi, t: PresetsT }): ReactNode {
  const [tick, setTick] = useState(0)
  const reload = () => setTick((n) => n + 1)
  const live = useQuery(() => api.call<DemoPresets>('GET', '/api/demo-presets'), [api, tick])
  const active = !!live.data && (live.data.busy || live.data.items.some((item) => running(item.job)))
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') reload() }, active ? 2000 : 5000)
    return () => clearInterval(id)
  }, [active])
  useEffect(() => {
    const offs = ['demo-preset', 'connection'].map((type) => api.onEvent(type, (e) => {
      if (e.type !== 'connection' || (e.data as { connected?: boolean } | undefined)?.connected) reload()
    }))
    return () => { for (const off of offs) off() }
  }, [api])
  return (
    <Page label={t('title')}>
      <PageHead title={t('title')} intro={t('intro')}
        actions={<Button variant="ghost" size="sm" icon={<IconRefreshOutlineRegular size={14} />} disabled={live.loading} onClick={reload}>{t('refresh')}</Button>} />
      {live.error !== undefined && !live.data && <LoadError title={t('loadFailed')} error={live.error} labels={refusalLabels(t)} retryLabel={t('retry')} onRetry={reload} />}
      {!live.data && live.loading && <Loading label={t('loading')} />}
      {live.data && live.data.items[0] && <Library api={api} t={t} data={live.data} preset={live.data.items.find((p) => p.id === 'studio') ?? live.data.items[0]} onRefresh={reload} />}
    </Page>
  )
}

function Library({ api, t, data, preset, onRefresh }: { api: LayerfsApi, t: PresetsT, data: DemoPresets, preset: DemoPreset, onRefresh: () => void }): ReactNode {
  const [selectedMode, setSelectedMode] = useState<PresetExecutionMode>()
  const executionMode = selectedMode ?? preset.executionMode ?? 'filesystem'
  const sandboxes = executionMode === 'mixed'
  const modeReady = preset.contentReady && preset.executionMode === executionMode
  const shown: DemoPreset = modeReady === preset.contentReady ? preset : { ...preset, contentReady: modeReady }
  const [script, setScript] = useState<{ open: boolean, resource?: PresetResource }>({ open: false })
  const [waiting, setWaiting] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [unknown, setUnknown] = useState<string>()
  const [failure, setFailure] = useState<unknown>()
  const disabled = waiting || data.busy || !!unknown
  const job = preset.job
  const name = t('studio')

  const prepare = async (build: boolean) => {
    setWaiting(true); setFailure(undefined)
    try {
      const plan = await api.call<EnvironmentResetPlan>('GET', build
        ? `/api/demo-presets/${enc(preset.id)}/${sandboxes ? 'build-plan' : 'build-plan-no-sandboxes'}?executionMode=${executionMode}`
        : `/api/demo-presets/${enc(preset.id)}/environment-plan`)
      setConfirmation({ build, sandboxes, executionMode, plan })
      onRefresh()
    } catch (e) { setFailure(e) } finally { setWaiting(false) }
  }
  const execute = async () => {
    if (!confirmation) return
    const requestId = crypto.randomUUID()
    setWaiting(true); setFailure(undefined)
    try {
      await api.call<PresetJob>('POST', `/api/demo-presets/${enc(preset.id)}/environment-reset`, { requestId, expectedPlan: confirmation.plan.signature, confirm: true, rebuild: confirmation.build, sandboxes: confirmation.sandboxes, executionMode: confirmation.executionMode })
      setConfirmation(undefined)
    } catch (e: any) {
      setFailure(e); setConfirmation(undefined)
      // A lost answer is reconciled by GET; a destructive request is never replayed.
      if (!(Number(e?.status) >= 400 && Number(e?.status) < 500)) setUnknown(requestId)
    } finally { setWaiting(false); onRefresh() }
  }
  const reconcile = async () => {
    if (!unknown) return
    setWaiting(true)
    try {
      const result = await api.call<PresetJob>('GET', `/api/demo-presets/requests/${enc(unknown)}`)
      setUnknown(undefined)
      setFailure(result.state === 'failed' || result.state === 'interrupted' ? new Error(result.phase) : undefined)
    } catch (e) { setFailure(e) } finally { setWaiting(false); onRefresh() }
  }

  const requirement = (code: string) => t(code === 'docker' ? 'reqDocker' : code === 'lima' ? 'reqLima' : 'reqDaemon')
  // The host answers for the saved mode; the daemon need follows the mode selected here.
  const requirements = executionMode === preset.executionMode ? preset.requirements : [...preset.requirements.filter((r) => r !== 'daemon'), ...(executionMode === 'mixed' ? ['daemon'] : [])]
  const blocked = sessionsOf(failure)
  const plan = confirmation?.plan
  const planBlocked = !!plan?.dsh.sessions.length

  return (
    <>
      <Card className={css.library} aria-label={name}>
        <div className={css.libraryHead}>
          <h2>{name}</h2>
          <Button variant="ghost" size="sm" title={t('resetTitle')} disabled={disabled || !preset.initialized} onClick={() => { void prepare(false) }}>{t('reset')}</Button>
        </div>
        <p className={css.muted}>{t('studioIntro')}</p>
        <div className={css.summary}>
          <span>{t('machines', { n: preset.machines.length })}</span>
          <span>{t('stores', { n: preset.stores })}</span>
          <span>{t('projects', { n: preset.projects })}</span>
        </div>
        <div className={css.mode}>
          <span className={css.modeLabel}>{t('modeLabel')}</span>
          <SegmentedControl<PresetExecutionMode> id="lfs-preset-mode" className={css.selfStart} value={executionMode} disabled={disabled} label={t('modeLabel')}
            options={[{ value: 'filesystem', label: t('modeFilesystem') }, { value: 'mixed', label: t('modeMixed') }]} onChange={setSelectedMode} />
          <p className={css.muted}>{t(executionMode === 'mixed' ? 'modeMixedBody' : 'modeFilesystemBody')}</p>
          {preset.settings && preset.built && preset.settings.executionMode !== executionMode && <p className={css.muted}>{t('modeDiffers')}</p>}
        </div>
        {requirements.length > 0 && <p className={css.note}>{t('requirements')}: {requirements.map(requirement).join(' · ')}</p>}
        {running(job) && <div className={css.running}><p className={css.runningTitle}>{t(job!.rebuild ? 'opBuild' : 'opReset', { name })}</p><PresetProgress job={job!} t={t} /></div>}
        <PresetTopology key={preset.id} preset={shown} t={t} onCommands={(resource) => setScript({ open: true, resource })} />
        <div className={css.actions}>
          <Button variant="outline" disabled={waiting} icon={<IconCodeOutlineRegular size={14} />} onClick={() => setScript({ open: true })}>{t('viewScript')}</Button>
          <Button variant="primary" disabled={disabled} icon={<IconPlayOutlineRegular size={14} />} onClick={() => { void prepare(true) }}>{t('build')}</Button>
        </div>
        <p className={css.note}>{t('buildNote')}</p>
        {waiting && !confirmation && <p className={css.status} role="status"><StateDot state="ongoing" />{t('checking')}</p>}
        {failure !== undefined && (
          <div className={css.failure}>
            <Refusal error={failure} labels={refusalLabels(t)} />
            {blocked.length > 0 && <SessionLinks api={api} t={t} sessions={blocked} />}
            {unknown && <Notice tone="warning">{t('outcomeUnknown')}</Notice>}
            <div className={css.actionsStart}>
              {unknown && <Button variant="outline" size="sm" disabled={waiting} onClick={() => { void reconcile() }}>{t('checkOperation')}</Button>}
              <Button variant="ghost" size="sm" disabled={waiting} onClick={() => { setFailure(undefined); setUnknown(undefined) }}>{t('dismiss')}</Button>
            </div>
          </div>
        )}
        {job && <Operation t={t} job={job} name={name} home={preset.home} previous={job.rebuild && job.state === 'completed' && !preset.contentReady} />}
      </Card>
      <ScriptDrawer api={api} t={t} preset={preset.id} sandboxes={sandboxes} executionMode={executionMode} open={script.open} resource={script.resource} onClose={() => setScript({ open: false })} />
      <Modal open={!!confirmation} onClose={() => { if (!waiting) setConfirmation(undefined) }} closeLabel={t('close')} className={css.confirmModal}
        title={confirmation?.build ? t('confirmBuild', { name }) : t('confirmReset')}
        description={confirmation?.build ? t('confirmBuildBody', { mode: t(confirmation.executionMode === 'mixed' ? 'modeMixed' : 'modeFilesystem') }) : t('confirmResetBody')}
        footer={(
          <div className={css.modalFooter}>
            <Button variant="outline" disabled={waiting} data-modal-autofocus="" onClick={() => setConfirmation(undefined)}>{t('cancel')}</Button>
            <Button variant="primary" className={css.dangerPrimary} disabled={waiting || data.busy || planBlocked} aria-busy={waiting} onClick={() => { void execute() }}>
              {waiting ? t('starting') : confirmation?.build ? t('resetAndBuild') : t('resetAction')}
            </Button>
          </div>
        )}>
        {plan && (
          <div className={css.confirm}>
            <Notice tone="danger">{t('confirmLoss')}</Notice>
            {planBlocked && <Notice tone="warning"><span>{t('confirmBlocked')}</span><SessionLinks api={api} t={t} sessions={plan.dsh.sessions} onOpen={() => setConfirmation(undefined)} /></Notice>}
            {plan.dsh.workspaces.length > 0 && (
              <div>
                <p>{t('confirmWorkspaces')}</p>
                <ul className={css.list}>{plan.dsh.workspaces.map((w) => <li key={w.project}>{t('confirmWorkspaceRow', { project: w.project, n: w.sessions })}</li>)}</ul>
              </div>
            )}
            <details className={css.disclosure}>
              <summary>{t('whatReset')}</summary>
              <p>{t('resetCounts', { stores: plan.remove.stores.length, projects: plan.projects, sandboxes: plan.remove.sandboxes.length, workspaces: plan.remove.workspaces.length, machines: plan.remove.machines.length })}</p>
              {plan.unknownSandboxes.length > 0 && <p>{t('unknownSandboxes')}</p>}
              {plan.disconnect.length > 0 && <p>{t('disconnectPg')}</p>}
              <p>{t('keepBuiltins')}</p>
              <p className={css.mono}>{plan.home}</p>
              <ul className={css.list}>
                {Object.entries(plan.remove).flatMap(([kind, names]) => (names as string[]).map((n) => <li key={`${kind}/${n}`} className={css.mono}>{kind}: {n}</li>))}
                {plan.projectKeys.map((k) => <li key={`project/${k}`} className={css.mono}>projects: {k}</li>)}
              </ul>
            </details>
          </div>
        )}
      </Modal>
    </>
  )
}

function SessionLinks({ api, t, sessions, onOpen }: { api: LayerfsApi, t: PresetsT, sessions: readonly BusySession[], onOpen?: () => void }): ReactNode {
  return (
    <ul className={css.list}>
      {sessions.map((s) => (
        <li key={s.id}>
          <LinkButton onClick={() => { onOpen?.(); api.openSession(s.id) }}>{t('openSession', { id: s.id })}</LinkButton>
          {s.project && <span className={css.muted}> · {t('sessionOf', { project: s.project })}</span>}
        </li>
      ))}
    </ul>
  )
}

function Operation({ t, job, name, home, previous }: { t: PresetsT, job: PresetJob, name: string, home: string, previous: boolean }): ReactNode {
  const cleanup = job.cleanup
  return (
    <section className={css.operation} aria-label={t(job.rebuild ? 'opBuild' : 'opReset', { name })}>
      <p className={css.runningTitle}>{previous ? t('opPreviousBuild') : t(job.rebuild ? 'opBuild' : 'opReset', { name })}</p>
      {!running(job) && <PresetProgress job={job} t={t} />}
      <details className={css.disclosure}>
        <summary>{t('log')}</summary>
        {job.log.length
          ? <pre className={css.log}>{job.log.map((line) => `${new Date(line.at).toLocaleTimeString()}  ${line.text}`).join('\n')}</pre>
          : <p className={css.muted}>{t('logEmpty')}</p>}
      </details>
      <details className={css.disclosure}>
        <summary>{t('receipt')}</summary>
        <p className={css.mono}>{t('home')}: {home}</p>
        {cleanup && <p>{t(cleanup.verified ? 'cleanupVerified' : 'cleanupUnverified')}</p>}
        {cleanup?.warnings?.map((warning, i) => <p key={i}>{warning}</p>)}
        {!!cleanup?.remaining?.length && <p className={css.error}>{t('remaining', { list: cleanup.remaining.join(', ') })}</p>}
        {!!job.forgotten?.length && <p>{t('forgotten', { list: job.forgotten.join(', ') })}</p>}
        <p className={css.muted}>{t('retained')}</p>
      </details>
    </section>
  )
}
