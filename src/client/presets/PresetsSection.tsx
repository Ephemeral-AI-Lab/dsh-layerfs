/**
 * One preset in the Presets dialog: its status line and actions.
 * Build/Rebuild opens a two-step dialog: the history options
 * (whether some commits go through sandbox workspaces) and then the impact,
 * confirmed against a fresh inventory plan. Stop machines (in the … menu)
 * confirms against the machine-stop plan. `usePresets` polls every 2 s while a
 * job runs and every 5 s otherwise, and again on `demo-preset` events. A lost
 * answer is reconciled by request ID, never resubmitted.
 */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Checkbox, IconCodeOutlineRegular, IconPlayOutlineRegular, MenuItemButton, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { enc, type LayerfsApi } from '../api.ts'
import type { BusySession, DemoPreset, DemoPresets, PresetResetPlan, PresetExecutionMode, PresetJob } from '../../shared/presets.ts'
import { useQuery } from '../files/use-query.ts'
import { Card, LinkButton, MoreMenu, Notice, Refusal } from '../ui/index.tsx'
import { refusalLabels } from './labels.ts'
import type { PresetsKey, PresetsT } from './locale.ts'
import { count, PresetProgress } from './Progress.tsx'
import { ScriptDrawer } from './ScriptDrawer.tsx'
import { PresetTopology, type PresetResource } from './Topology.tsx'
import css from './presets.module.css'
import { ReadDeadlineError, readWithDeadline } from '../projects/read-deadline.ts'

/** The Resources page's panel id (kept literal: importing the Storage area would bundle its registration here). */
const STORAGE_PANEL = 'layerfs-storage'

/** The open dialog: Build's options, then a plan to confirm (Build or Stop machines). */
type Dialog =
  | { kind: 'build', mixed: boolean, plan?: PresetResetPlan }
  | { kind: 'stop', mixed?: undefined, plan: PresetResetPlan }
const running = (job: PresetJob | null | undefined) => job?.state === 'queued' || job?.state === 'running'
const sessionsOf = (error: unknown): BusySession[] => {
  const list = (error as { detail?: { sessions?: unknown } } | null)?.detail?.sessions
  return Array.isArray(list) ? list as BusySession[] : []
}
/** The words for how a library's history is written. */
export const modeKey = (mode: PresetExecutionMode): PresetsKey => mode === 'mixed' ? 'modeMixed' : 'modeFilesystem'

/**
 * The presets listing, kept fresh while a view shows it: every 2 s while a job
 * runs, every 5 s otherwise, and again on `demo-preset` and reconnect events.
 */
export function usePresets(api: LayerfsApi): { data: DemoPresets | undefined, error: unknown, loading: boolean, reload: () => void } {
  const [tick, setTick] = useState(0)
  const reload = () => setTick((n) => n + 1)
  const live = useQuery(() => api.call<DemoPresets>('GET', '/api/demo-presets'), [api], { refresh: [tick], cache: 'layerfs-presets' })
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
  return { data: live.data, error: live.error, loading: live.loading, reload }
}

/** A preset's name in words. */
export function presetName(t: PresetsT, preset: DemoPreset): string {
  return preset.id === 'studio' ? t('studio') : preset.id === 'quickstart' ? t('quickstart') : preset.id
}

/** All commits a preset's projects plan. */
export const presetCommits = (preset: DemoPreset): number => preset.projectDefinitions.reduce((n, p) => n + p.history.commits, 0)

/** One sentence on what a preset builds. */
export function presetIntro(t: PresetsT, preset: DemoPreset): string {
  if (preset.id === 'studio') return t('studioIntro', { projects: preset.projects, machines: preset.machines.length })
  const only = preset.projectDefinitions[0]
  if (preset.id === 'quickstart' && only) return t('quickstartIntro', { branches: count(only.history.branches), commits: count(only.history.commits) })
  return preset.description
}

export { running as presetRunning }

/** One preset: its name, status, actions, machines and projects, and the Build / Stop dialogs. */
export function Library({ api, t, data, preset, onRefresh, className }: { api: LayerfsApi, t: PresetsT, data: DemoPresets, preset: DemoPreset, onRefresh: () => void, className?: string }): ReactNode {
  // The host answers for the saved library's mode; the script shows that plan.
  const builtMode = preset.executionMode ?? 'filesystem'
  const [script, setScript] = useState<{ open: boolean, resource?: PresetResource }>({ open: false })
  const [waiting, setWaiting] = useState(false)
  const [dialog, setDialog] = useState<Dialog>()
  const [planFailure, setPlanFailure] = useState<unknown>()
  const [unknown, setUnknown] = useState<string>()
  const [failure, setFailure] = useState<unknown>()
  const disabled = waiting || data.busy || !!unknown
  const job = preset.job
  const name = presetName(t, preset)
  const built = preset.built || preset.contentReady

  const plan = async (build: boolean, mixed: boolean): Promise<PresetResetPlan> => {
    try {
      return await readWithDeadline(api.call<PresetResetPlan>('GET', build
        ? `/api/demo-presets/${enc(preset.id)}/${mixed ? 'build-plan' : 'build-plan-no-sandboxes'}?executionMode=${mixed ? 'mixed' : 'filesystem'}`
        : `/api/demo-presets/${enc(preset.id)}/environment-plan`), 60_000)
    } catch (e) { throw e instanceof ReadDeadlineError ? new Error(t('planTimeout')) : e }
  }
  const openBuild = () => { setFailure(undefined); setPlanFailure(undefined); setDialog({ kind: 'build', mixed: builtMode === 'mixed' }) }
  const checkBuild = async (mixed: boolean) => {
    setWaiting(true); setPlanFailure(undefined)
    try { setDialog({ kind: 'build', mixed, plan: await plan(true, mixed) }); onRefresh() } catch (e) { setPlanFailure(e) } finally { setWaiting(false) }
  }
  const openStop = async () => {
    setWaiting(true); setFailure(undefined)
    try { setDialog({ kind: 'stop', plan: await plan(false, false) }); onRefresh() } catch (e) { setFailure(e) } finally { setWaiting(false) }
  }
  const execute = async () => {
    if (!dialog?.plan) return
    const build = dialog.kind === 'build'
    const mixed = !!dialog.mixed
    const requestId = crypto.randomUUID()
    setWaiting(true); setFailure(undefined)
    try {
      await api.call<PresetJob>('POST', `/api/demo-presets/${enc(preset.id)}/environment-reset`, { requestId, expectedPlan: dialog.plan.signature, confirm: true, rebuild: build, sandboxes: mixed, executionMode: mixed ? 'mixed' : 'filesystem', force: !build || dialog.plan.dsh.sessions.length > 0 })
      setDialog(undefined)
    } catch (e: any) {
      setFailure(e); setDialog(undefined)
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
  const close = () => { if (!waiting) { setDialog(undefined); setPlanFailure(undefined) } }
  const blocked = sessionsOf(failure)

  return (
    <>
      <Card className={clsx(css.library, className)} aria-label={name}>
        <div className={css.libraryHead}>
          <div className={css.headText}>
            <h2>{name}</h2>
            <p className={css.muted}>{presetIntro(t, preset)}</p>
          </div>
          <div className={css.headActions}>
            <Button variant="outline" size="sm" icon={<IconCodeOutlineRegular size={14} />} onClick={() => setScript({ open: true })}>{t('viewScript')}</Button>
            <Button variant="primary" size="sm" disabled={disabled} icon={<IconPlayOutlineRegular size={14} />} onClick={openBuild}>{t(built ? 'rebuild' : 'build')}</Button>
            <MoreMenu label={t('moreActions')} disabled={disabled}>
              {(closeMenu) => (
                <MenuItemButton disabled={!preset.initialized} disabledReason={t('stopUnavailable')} onSelect={() => { closeMenu(); void openStop() }}>{t('stopMachines')}</MenuItemButton>
              )}
            </MoreMenu>
          </div>
        </div>
        <LibraryStatus api={api} t={t} preset={preset} checking={waiting && !dialog} />
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
        <PresetTopology key={preset.id} preset={preset} t={t} onCommands={(resource) => setScript({ open: true, resource })} />
        {job && !running(job) && <Operation t={t} job={job} home={preset.home} previous={job.rebuild && job.state === 'completed' && !preset.contentReady} />}
      </Card>
      <ScriptDrawer api={api} t={t} preset={preset.id} sandboxes={builtMode === 'mixed'} executionMode={builtMode} open={script.open} resource={script.resource} onClose={() => setScript({ open: false })} />
      <Modal open={!!dialog} onClose={close} closeLabel={t('close')} className={css.confirmModal}
        title={dialog?.kind === 'stop' ? t('confirmStop', { name }) : t(built ? 'confirmRebuild' : 'confirmBuild', { name })}
        description={dialog?.kind === 'stop' ? t('confirmStopBody') : dialog?.plan ? t('confirmBuildBody', { mode: t(modeKey(dialog.mixed ? 'mixed' : 'filesystem')) }) : t('buildOptionsBody')}
        footer={(
          <div className={css.modalFooter}>
            {dialog?.kind === 'build' && dialog.plan
              ? <Button variant="outline" disabled={waiting} onClick={() => setDialog({ kind: 'build', mixed: dialog.mixed })}>{t('back')}</Button>
              : <Button variant="outline" disabled={waiting} data-modal-autofocus="" onClick={close}>{t('cancel')}</Button>}
            {dialog?.kind === 'build' && !dialog.plan
              ? <Button variant="primary" disabled={waiting || data.busy} aria-busy={waiting} onClick={() => { void checkBuild(dialog.mixed) }}>{waiting ? t('checking') : t('continue')}</Button>
              : <Button variant="primary" className={css.dangerPrimary} disabled={waiting || data.busy} aria-busy={waiting} onClick={() => { void execute() }}>
                  {waiting ? t('starting') : dialog?.kind === 'stop' ? t('stopAction') : t('resetAndBuild')}
                </Button>}
          </div>
        )}>
        {dialog?.kind === 'build' && !dialog.plan && (
          <BuildOptions t={t} preset={preset} mixed={dialog.mixed} disabled={waiting} failure={planFailure}
            onMixed={(mixed) => { setPlanFailure(undefined); setDialog({ kind: 'build', mixed }) }} />
        )}
        {dialog?.plan && <PlanImpact t={t} plan={dialog.plan} build={dialog.kind === 'build'} />}
      </Modal>
    </>
  )
}

/** One line for the library: running, built and verified, needs a rebuild, or not built. */
function LibraryStatus({ api, t, preset, checking }: { api: LayerfsApi, t: PresetsT, preset: DemoPreset, checking: boolean }): ReactNode {
  const job = preset.job
  if (running(job)) {
    return (
      <div className={css.running}>
        <p className={css.runningTitle}>{t(job!.rebuild ? 'opBuilding' : 'opStopping')}</p>
        <PresetProgress job={job!} t={t} />
      </div>
    )
  }
  if (checking) return <p className={css.status} role="status"><StateDot state="ongoing" />{t('checking')}</p>
  const last = preset.lastBuild
  if (preset.contentReady) {
    const when = last ? new Date(last.ended).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''
    return (
      <p className={css.status} role="status">
        <StateDot state="done" />
        <span>{t(when ? 'statusBuilt' : 'statusBuiltUndated', { when, mode: t(modeKey(last?.executionMode ?? preset.executionMode)) })}</span>
        <LinkButton className={css.statusLink} onClick={() => api.openPanel(STORAGE_PANEL)}>{t('openStorage')}</LinkButton>
      </p>
    )
  }
  if (preset.built) return <p className={css.status} role="status"><StateDot state="warning" />{t('statusStale')}</p>
  return <p className={css.status} role="status"><StateDot state="idle" />{preset.projects === 1 ? t('statusNotBuiltOne') : t('statusNotBuilt', { projects: preset.projects })}</p>
}

/** Build's first step: how the history is written, and what that needs. */
function BuildOptions({ t, preset, mixed, disabled, failure, onMixed }: { t: PresetsT, preset: DemoPreset, mixed: boolean, disabled: boolean, failure: unknown, onMixed: (mixed: boolean) => void }): ReactNode {
  // The host lists needs for the saved mode; only the daemon need follows the choice here.
  const needs = [...preset.requirements.filter((r) => r !== 'daemon'), ...(mixed ? ['daemon'] : [])]
  const need = (code: string) => t(code === 'docker' ? 'reqDocker' : code === 'lima' ? 'reqLima' : 'reqDaemon')
  return (
    <div className={css.confirm}>
      <div className={css.option}>
        <Checkbox checked={mixed} disabled={disabled} onChange={onMixed} label={t('mixedOption')} />
        <p className={css.optionHint}>{t('mixedOptionHint')}</p>
      </div>
      {needs.length > 0 && (
        <div>
          <p className={css.label}>{t('requirements')}</p>
          <ul className={css.list}>{needs.map((code) => <li key={code}>{need(code)}</li>)}</ul>
        </div>
      )}
      <Notice tone="danger">{t('buildWipes')}</Notice>
      {failure !== undefined && <Refusal error={failure} labels={refusalLabels(t)} />}
    </div>
  )
}

/** What a confirmed plan removes, stops or deletes. */
function PlanImpact({ t, plan, build }: { t: PresetsT, plan: PresetResetPlan, build: boolean }): ReactNode {
  return (
    <div className={css.confirm}>
      <Notice tone="danger">{t(build ? 'confirmLoss' : 'stopLoss')}</Notice>
      {plan.dsh.conversations.length > 0 && <Notice tone="warning">{plan.dsh.conversations.length === 1 ? t('deleteSessionsOne') : t('deleteSessionsMany', { n: plan.dsh.conversations.length })}</Notice>}
      {plan.dsh.workspaces.length > 0 && (
        <div>
          <p>{t('confirmWorkspaces')}</p>
          <ul className={css.list}>{plan.dsh.workspaces.map((w) => <li key={w.project}>{t('confirmWorkspaceRow', { project: w.project, n: w.sessions })}</li>)}</ul>
        </div>
      )}
      <details className={css.disclosure}>
        <summary>{t(plan.scope === 'machines' ? 'whatStop' : 'whatReset')}</summary>
        {plan.scope === 'machines' ? (
          <>
            <p>{t('stopCounts', { n: plan.stopMachines.length })}</p>
            <p>{t('stopPreserved')}</p>
            <p className={css.mono}>{plan.home}</p>
            <ul className={css.list}>{plan.stopMachines.map((machine) => <li key={machine} className={css.mono}>{machine}</li>)}</ul>
          </>
        ) : (
          <>
            <p>{t('resetCounts', { stores: plan.remove.stores.length, projects: plan.projects, sandboxes: plan.remove.sandboxes.length, workspaces: plan.remove.workspaces.length, machines: plan.remove.machines.length })}</p>
            {plan.unknownSandboxes.length > 0 && <p>{t('unknownSandboxes')}</p>}
            {plan.disconnect.length > 0 && <p>{t('disconnectPg')}</p>}
            <p>{t('keepBuiltins')}</p>
            <p className={css.mono}>{plan.home}</p>
            <ul className={css.list}>
              {Object.entries(plan.remove).flatMap(([kind, names]) => (names as string[]).map((n) => <li key={`${kind}/${n}`} className={css.mono}>{removeRow(t, kind, n)}</li>))}
              {plan.projectKeys.map((k) => <li key={`project/${k}`} className={css.mono}>{t('removeProject', { name: k })}</li>)}
            </ul>
          </>
        )}
      </details>
    </div>
  )
}

const removeKey = { stores: 'removeStore', sandboxes: 'removeSandbox', machines: 'removeMachine', workspaces: 'removeWorkspace' } as const

/** One resource a Reset removes, in words (`Store: studio`). */
function removeRow(t: PresetsT, kind: string, name: string): string {
  return Object.hasOwn(removeKey, kind) ? t(removeKey[kind as keyof typeof removeKey], { name }) : t('removeOther', { kind, name })
}

function SessionLinks({ api, t, sessions }: { api: LayerfsApi, t: PresetsT, sessions: readonly BusySession[] }): ReactNode {
  return (
    <ul className={css.list}>
      {sessions.map((s) => (
        <li key={s.id}>
          <LinkButton onClick={() => api.openSession(s.id)}>{t('openSession', { id: s.id })}</LinkButton>
          {s.project && <span className={css.muted}> · {t('sessionOf', { project: s.project })}</span>}
        </li>
      ))}
    </ul>
  )
}

/** The last finished operation: its outcome, log and receipt. */
function Operation({ t, job, home, previous }: { t: PresetsT, job: PresetJob, home: string, previous: boolean }): ReactNode {
  const cleanup = job.cleanup
  const operationKey = previous ? 'opPreviousBuild' : job.rebuild ? 'opLastBuild' : job.command === 'machine-stop' ? 'opLastStop' : 'opLegacyReset'
  return (
    <section className={css.operation} aria-label={t(operationKey)}>
      <p className={css.runningTitle}>{t(operationKey)}</p>
      <PresetProgress job={job} t={t} />
      <details className={css.disclosure}>
        <summary>{t('log')}</summary>
        {job.log.length
          ? <pre className={css.log}>{job.log.map((line) => `${new Date(line.at).toLocaleTimeString()}  ${line.text}`).join('\n')}</pre>
          : <p className={css.muted}>{t('logEmpty')}</p>}
      </details>
      <details className={css.disclosure}>
        <summary>{t('receipt')}</summary>
        <p className={css.mono}>{t('home')}: {home}</p>
        {cleanup && <p>{t(cleanup.scope === 'machines' ? (cleanup.verified ? 'stopVerified' : 'stopUnverified') : (cleanup.verified ? 'cleanupVerified' : 'cleanupUnverified'))}</p>}
        {cleanup?.warnings?.map((warning, i) => <p key={i}>{warning}</p>)}
        {!!cleanup?.remaining?.length && <p className={css.error}>{t('remaining', { list: cleanup.remaining.join(', ') })}</p>}
        {!!job.forgotten?.length && <p>{t('forgotten', { list: job.forgotten.join(', ') })}</p>}
        {job.deletedSessions && <p>{t('deletedSessions', { n: job.deletedSessions.length })}</p>}
        <p className={css.muted}>{t(job.command === 'machine-stop' ? 'stopPreserved' : 'retained')}</p>
      </details>
    </section>
  )
}
