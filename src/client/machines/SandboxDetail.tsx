/**
 * One Sandbox's page. Its head (name, state, machine, project) and its tabs
 * are drawn from the `sandbox.list` row the machines view already holds, so
 * the page never waits on one slow read (layerfs-project#179 D): only
 * Terminals (the Workspaces as terminals, SandboxTerminals.tsx, with the
 * daemon line and the record's other fields under Record details) waits on
 * sandbox.get. Files (InspectFiles.tsx) and Daemon log (LogPane.tsx) read on
 * their own, and each is there only when the pinned CLI has its call
 * (sandbox.files, logs.sandbox).
 *
 * Delete is sandbox.close, with an explicit Force delete action. A Sandbox
 * whose machine differs from the one it was opened from is refused here.
 */
import { useId, useState, type ReactNode } from 'react'
import { Button, IconChevronRightOutlineRegular, IconRefreshOutlineRegular, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import { DoctorAction } from '../doctor/Doctor.tsx'
import { Card, Fact, Facts, LinkButton, LoadError, Loading, Notice, Page, PageHead, Refusal, StateChip } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { useDetailTab } from './detail-tabs.ts'
import { SandboxGlyph } from './icons.tsx'
import { displayRef } from './images.ts'
import { useMachineTitle } from './Inventory.tsx'
import { InspectFiles } from './InspectFiles.tsx'
import { LogPane } from './LogPane.tsx'
import type { View } from './context.tsx'
import { cachedAnswer } from '../ui/use-query.ts'
import { clearingCall, daemonLook, daemonSlots, opWords, stateLook, type SandboxImagesView, type SandboxInfo } from './model.ts'
import { SandboxMenu, useClose, useSandboxRead } from './Sandboxes.tsx'
import { SandboxTerminals } from './SandboxTerminals.tsx'
import css from './machines.module.css'
import logCss from './log.module.css'
import term from './terminal.module.css'

export function SandboxDetail({ machine, name, go }: { machine: string, name: string, go: (view: View) => void }): ReactNode {
  const { t, stateWord, refusal, kind, api, doctorT, useMachines } = useMachinesContext()
  const listed = useMachines((s) => (s.data?.available ? s.data.sandboxes.find((b) => b.name === name) : undefined))
  const parent = useMachines((s) => (s.data?.available ? s.data.machines.find((m) => m.name === machine) : undefined))
  const hasLog = useMachines((s) => (s.data?.available ? s.data.features?.inspect?.sandboxLog === true : false))
  const hasFiles = useMachines((s) => (s.data?.available ? s.data.features?.inspect?.files === true : false))
  // the Workspace whose terminal Files asked for ("Open terminal")
  const [focus, setFocus] = useState<{ ws: string, n: number } | null>(null)
  const detail = useSandboxRead(name, listed?.state, listed?.workspaces)
  const closing = useClose(name)
  const title = useMachineTitle()
  const machineTitle = title({ name: machine, platform: parent?.platform ?? (machine === 'native' ? 'native' : '') })
  const tabs: { value: 'terminals' | 'files' | 'log', label: string }[] = [
    { value: 'terminals', label: t('tabTerminals') },
    ...(hasFiles ? [{ value: 'files' as const, label: t('tabFiles') }] : []),
    ...(hasLog ? [{ value: 'log' as const, label: t('tabDaemonLog') }] : []),
  ]
  const [tab, setTab] = useDetailTab('sandbox', name, tabs.map((x) => x.value), 'terminals')
  const ids = useId()
  const crumbs = [
    { label: t('panel'), ariaLabel: t('backToMachines'), onClick: () => go({ kind: 'board' }) },
    { label: machineTitle, onClick: () => go({ kind: 'machine', name: machine }) },
  ]
  const info = detail.data
  const targetMachine = info?.machine ?? listed?.machine
  const wrong = !!targetMachine && targetMachine !== machine
  // neither the list row nor sandbox.get knows it (yet): nothing to draw a head from
  if ((!info && !listed) || wrong) {
    return (
      <Page wide label={name}>
        <PageHead title={name} crumbs={crumbs} current={name} icon={<SandboxGlyph size={22} />}
          actions={!wrong ? <SandboxMenu name={name} op={listed?.op} closing={closing} onDeleted={() => go({ kind: 'machine', name: machine })} /> : undefined} />
        {wrong
          ? <Notice tone="danger"><p>{t('sandboxWrongMachine', { name, machine })}</p></Notice>
          : detail.error != null
            ? <LoadError title={t('readSandboxFailed')} error={detail.error} labels={refusal} retryLabel={t('retry')} onRetry={detail.reload} />
            : <Loading label={t('readingSandbox')} />}
        {closing.error != null && <Refusal error={closing.error} labels={refusal} />}
      </Page>
    )
  }
  // the head: sandbox.get's answer once it is in, the list row until then (and when it never answers)
  const state = info?.state ?? listed?.state ?? 'unknown'
  const currentOp = info ? info.op ?? null : listed?.op ?? null
  const look = stateLook('sandbox', state)
  const op = opWords(currentOp)
  const calls = state === 'unresolved' ? clearingCall('sandbox', name, currentOp) : null
  const project = info?.project ?? listed?.project ?? null
  const intro = [
    t('sbOnMachine', { machine: machineTitle, kind: parent ? kind(parent.platform) : info?.platform ?? '—' }),
    project ? t('sandboxProject', { project }) : t('noProject'),
  ].join(' · ')
  const logLink = hasLog && tab !== 'log' ? <LinkButton onClick={() => setTab('log')}>{t('openDaemonLog')}</LinkButton> : null
  // a Sandbox that ended behind LayerFS's back, or whose record has no runtime: a refused log read will not get better by waiting
  const ended = state === 'lost' || state === 'gone'
  return (
    <Page wide label={name}>
      <PageHead
        crumbs={crumbs}
        current={name}
        icon={<SandboxGlyph size={22} />}
        title={name}
        badge={<StateChip tone={look.tone} live={look.live} dashed={look.dashed} label={stateWord(look)} op={op} title={op ? t(currentOp?.uncertain ? 'opTitleUncertain' : 'opTitle', { op }) : undefined} />}
        intro={intro}
        actions={(
          <>
            <DoctorAction api={api} t={doctorT} target="sandbox" name={name} label={doctorT('diagnose')} />
            <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />} onClick={detail.reload}>{t('refresh')}</Button>
            <SandboxMenu name={name} op={currentOp} closing={closing} onDeleted={() => go({ kind: 'machine', name: machine })} />
          </>
        )}
      />

      {info && <DaemonLine info={info} action={logLink} />}

      {((info && (info.refusal || info.downReason)) || calls || closing.error !== null || !!closing.unknown?.length || (info && detail.error != null)) && (
        <Notice tone="danger">
          {info?.downReason && <p>{t('wsUnavailable', { reason: info.downReason })}{logLink ? <> · {logLink}</> : null}</p>}
          {info?.down && <p>{t('sbCapacityDown', { pool: String(info.down.pool_vacant ?? '—'), reserved: String(info.down.reserved_vacant ?? '—'), retained: String(info.down.retained ?? '—') })}</p>}
          {info?.refusal && <Refusal error={info.refusal} labels={refusal} compact />}
          {info && detail.error != null && <Refusal error={detail.error} labels={refusal} compact />}
          {calls && <p><code>{t('clearingCall', { status: calls.status, clear: calls.clear })}</code></p>}
          {closing.error !== null && <Refusal error={closing.error} labels={refusal} />}
          {!!closing.unknown?.length && <p>{t('forceClosedUnknown', { list: closing.unknown.join(', ') })}</p>}
        </Notice>
      )}

      {tabs.length > 1 && (
        <SegmentedTabs size="sm" className={logCss.tabs} label={t('machineTabs', { name })} value={tab} onChange={setTab}
          items={tabs.map((x) => ({ value: x.value, label: x.label, id: `${ids}-${x.value}`, panelId: `${ids}-${x.value}-panel` })) as [never, ...never[]]} />
      )}

      {tab === 'files' ? (
        // reads on its own: the Workspace rows take their names and chips from sandbox.get when it has answered
        <div className={logCss.tabPanel} role="tabpanel" id={`${ids}-files-panel`} aria-labelledby={`${ids}-files`}>
          <InspectFiles kind="sandbox" name={name} label={t('filesOf', { name })} workspaces={info?.workspaces ?? null} project={project}
            onOpenLog={hasLog ? () => setTab('log') : undefined} logTab={hasLog ? t('tabDaemonLog') : undefined}
            onOpenTerminal={(ws) => { setFocus((f) => ({ ws, n: (f?.n ?? 0) + 1 })); setTab('terminals') }} />
        </div>
      ) : tab === 'log' ? (
        <div className={logCss.tabPanel} role="tabpanel" id={`${ids}-log-panel`} aria-labelledby={`${ids}-log`}>
          <LogPane kind="sandbox" name={name} label={t('daemonLogOf', { name })} final={ended} />
        </div>
      ) : (
        <div className={logCss.tabPanel} {...(tabs.length > 1 ? { role: 'tabpanel', id: `${ids}-terminals-panel`, 'aria-labelledby': `${ids}-terminals` } : {})} data-sandbox-terminals>
          {!info
            // only this tab waits on sandbox.get
            ? detail.error != null
              ? <LoadError title={t('readSandboxFailed')} error={detail.error} labels={refusal} retryLabel={t('retry')} onRetry={detail.reload} />
              : <Loading label={t('readingSandbox')} />
            : (
              <>
                <SandboxTerminals info={info} onChanged={detail.reload} focus={focus} />

                <details className={css.details}>
                  <summary className={css.detailsSummary}><IconChevronRightOutlineRegular size={12} className={css.detailsChevron} /><span>{t('sbDetails')}</span></summary>
                  <div className={css.detailsBody}>
                    <Card>
                      <Facts>
                        <Fact label={t('project')} mono>{info.project}</Fact>
                        <ImageFact info={info} machine={machine} />
                        <Fact label={t('filesystemRoute')}>{info.route}</Fact>
                        <Fact label={t('runtime')}>{info.runtime}</Fact>
                        <Fact label={t('sbBackend')}>{info.backend}</Fact>
                        {info.platform && <Fact label={t('platform')}>{info.platform}</Fact>}
                        {info.created != null && <Fact label={t('created')}>{new Date(info.created < 1e12 ? info.created * 1000 : info.created).toLocaleString()}</Fact>}
                        {info.runtimeId && <Fact label={t('runtimeReference')} mono>{info.runtimeId}</Fact>}
                      </Facts>
                    </Card>
                    <RetainedFailures info={info} />
                  </div>
                </details>
              </>
            )}
        </div>
      )}
    </Page>
  )
}

/** The daemon in one line: reachable or not, its free control slots and retained failures; `action` links to its log. */
function DaemonLine({ info, action }: { info: SandboxInfo, action?: ReactNode }): ReactNode {
  const { t } = useMachinesContext()
  const daemon = daemonLook(info)
  const slots = daemonSlots(info)
  const failures = info.daemonCapacity?.retained?.count ?? info.daemonCapacity?.retained?.failures?.length ?? 0
  return (
    <p className={term.daemonLine} data-tone={daemon.tone}>
      <span className={term.daemonDot} aria-hidden="true" />
      <span>{t(daemon.key)}</span>
      {slots && <span>· {t('sbSlotsFree', { free: String(slots.free), total: String(slots.total) })}</span>}
      {failures > 0 && <span>· {failures === 1 ? t('sbFailuresOne') : t('sbFailures', { n: String(failures) })}</span>}
      {action ? <span>· {action}</span> : null}
    </p>
  )
}

/** The daemon's retained connection failures (sandbox.get daemon_capacity.retained). */
function RetainedFailures({ info }: { info: SandboxInfo }): ReactNode {
  const { t } = useMachinesContext()
  const failures = info.daemonCapacity?.retained?.failures ?? []
  if (!failures.length) return null
  return (
    <Card className={css.tableCard}>
      <table className={css.rows} aria-label={t('sbRetained')}>
        <thead><tr><th>{t('sbSlot')}</th><th className={css.colWide}>{t('sbCause')}</th><th>{t('sbAge')}</th></tr></thead>
        <tbody>
          {failures.map((f, i) => (
            <tr key={i}>
              <td className={css.mono}>{[f.class, f.slot].filter((v) => v != null).join(' ')}</td>
              <td className={css.colWide}>{f.cause ?? '—'}</td>
              <td className={css.muted}>{f.age_ms != null ? `${Math.round(f.age_ms / 1000)}s` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

/** The Sandbox's image: its name when the machine's last images answer (New Sandbox's) knows the id, else the id as LayerFS gives it. */
function ImageFact({ info, machine }: { info: SandboxInfo, machine: string }): ReactNode {
  const { t } = useMachinesContext()
  const known = info.image ? cachedAnswer<SandboxImagesView>(`machines:images:${info.machine ?? machine}`)?.ready.find((r) => r.id === info.image) : undefined
  const name = known ? (known.source === 'bundle' ? t('imageLayerfsDefault') : known.name || displayRef(known.refs)) : null
  return (
    <Fact label={t('image')} mono={!name} title={info.image ?? undefined}>
      {name ?? info.image ?? (info.backend === 'native' ? t('imageNone') : null)}
    </Fact>
  )
}
