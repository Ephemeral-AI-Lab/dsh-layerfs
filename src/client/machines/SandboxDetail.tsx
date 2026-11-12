/**
 * One Sandbox's page (sandbox.get), organised around what is mounted where
 * and what has not been captured yet:
 *
 *   head      name, state, machine and project, Diagnose / Refresh / …
 *   facts     daemon, control slots, Workspaces, uncaptured changes, runtime, image
 *   body      the mount map (image root and each Workspace at its path) beside
 *             the selected Workspace: layers and commands (SandboxWorkspace.tsx)
 *   details   the record's remaining fields and the daemon's retained failures
 *
 * Delete is sandbox.close, with an explicit Force delete action. A Sandbox
 * whose machine differs from the one it was opened from is refused here.
 */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconFolderCloseRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { DoctorAction } from '../doctor/Doctor.tsx'
import { Card, Empty, Fact, Facts, LoadError, Loading, Notice, Page, PageHead, Refusal, StateChip } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { SandboxGlyph } from './icons.tsx'
import type { View } from './context.tsx'
import {
  SANDBOX_CAPACITY, clearingCall, daemonLook, daemonSlots, mountRows, opWords, overlayCount, overlayDirty, shortImage, stateLook, uncaptured, workspaceName,
  type SandboxInfo, type WorkspaceInfo,
} from './model.ts'
import { SandboxMenu, useClose, useSandboxRead } from './Sandboxes.tsx'
import { WorkspacePane } from './SandboxWorkspace.tsx'
import css from './machines.module.css'

export function SandboxDetail({ machine, name, go }: { machine: string, name: string, go: (view: View) => void }): ReactNode {
  const { t, stateWord, refusal, kind, api, doctorT, useMachines } = useMachinesContext()
  const listed = useMachines((s) => (s.data?.available ? s.data.sandboxes.find((b) => b.name === name) : undefined))
  const parent = useMachines((s) => (s.data?.available ? s.data.machines.find((m) => m.name === machine) : undefined))
  const detail = useSandboxRead(name, listed?.state, listed?.workspaces)
  const closing = useClose(name)
  const crumbs = [
    { label: t('panel'), ariaLabel: t('backToMachines'), onClick: () => go({ kind: 'board' }) },
    { label: machine, onClick: () => go({ kind: 'machine', name: machine }) },
  ]
  const info = detail.data
  const targetMachine = info?.machine ?? listed?.machine
  const wrong = !!targetMachine && targetMachine !== machine
  if (!info || wrong) {
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
  const look = stateLook('sandbox', info.state)
  const op = opWords(info.op)
  const calls = info.state === 'unresolved' ? clearingCall('sandbox', name, info.op) : null
  const intro = [
    t('sbOnMachine', { machine, kind: parent ? kind(parent.platform) : info.platform ?? '—' }),
    info.project ? t('sandboxProject', { project: info.project }) : t('noProject'),
  ].join(' · ')
  return (
    <Page wide label={name}>
      <PageHead
        crumbs={crumbs}
        current={name}
        icon={<SandboxGlyph size={22} />}
        title={name}
        badge={<StateChip tone={look.tone} live={look.live} dashed={look.dashed} label={stateWord(look)} op={op} title={op ? t(info.op?.uncertain ? 'opTitleUncertain' : 'opTitle', { op }) : undefined} />}
        intro={intro}
        actions={(
          <>
            <DoctorAction api={api} t={doctorT} target="sandbox" name={name} label={doctorT('diagnose')} />
            <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />} onClick={detail.reload}>{t('refresh')}</Button>
            <SandboxMenu name={name} op={info.op ?? null} closing={closing} onDeleted={() => go({ kind: 'machine', name: machine })} />
          </>
        )}
      />

      <SandboxFacts info={info} />

      {(info.refusal || detail.error != null || calls || info.downReason || closing.error !== null || !!closing.unknown?.length) && (
        <Notice tone="danger">
          {info.downReason && <p>{t('wsUnavailable', { reason: info.downReason })}</p>}
          {info.down && <p>{t('sbCapacityDown', { pool: String(info.down.pool_vacant ?? '—'), reserved: String(info.down.reserved_vacant ?? '—'), retained: String(info.down.retained ?? '—') })}</p>}
          {info.refusal && <Refusal error={info.refusal} labels={refusal} compact />}
          {detail.error != null && <Refusal error={detail.error} labels={refusal} compact />}
          {calls && <p><code>{t('clearingCall', { status: calls.status, clear: calls.clear })}</code></p>}
          {closing.error !== null && <Refusal error={closing.error} labels={refusal} />}
          {!!closing.unknown?.length && <p>{t('forceClosedUnknown', { list: closing.unknown.join(', ') })}</p>}
        </Notice>
      )}

      <SandboxBody info={info} onChanged={detail.reload} />

      <details className={css.details}>
        <summary className={css.detailsSummary}>
          <span>{t('sbDetails')}</span>
        </summary>
        <div className={css.detailsBody}>
          <Card>
            <Facts>
              <Fact label={t('project')} mono>{info.project}</Fact>
              <Fact label={t('image')} mono title={info.image ?? undefined}>{info.image ?? (info.backend === 'native' ? t('imageNone') : null)}</Fact>
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
    </Page>
  )
}

/** The row of facts under the head: the daemon first, since every other answer depends on it. */
function SandboxFacts({ info }: { info: SandboxInfo }): ReactNode {
  const { t } = useMachinesContext()
  const daemon = daemonLook(info)
  const slots = daemonSlots(info)
  const failures = info.daemonCapacity?.retained?.count ?? info.daemonCapacity?.retained?.failures?.length ?? 0
  const known = !info.refusal && !info.unread && !info.downReason
  const changes = !known ? null : info.workspaces.length ? uncaptured(info.workspaces) : { inodes: 0, entries: 0 }
  const native = info.backend === 'native' || info.runtime === 'host_process'
  return (
    <dl className={css.factRow} aria-label={t('overview')}>
      <div>
        <dt>{t('sbDaemon')}</dt>
        <dd className={css.daemonValue} data-tone={daemon.tone}>
          <span className={css.daemonDot} aria-hidden="true" />{t(daemon.key)}
          {failures > 0 && <span className={css.muted}> · {failures === 1 ? t('sbFailuresOne') : t('sbFailures', { n: String(failures) })}</span>}
        </dd>
      </div>
      <div><dt>{t('sbSlots')}</dt><dd>{slots ? t('sbSlotsFree', { free: String(slots.free), total: String(slots.total) }) : t('notReported')}</dd></div>
      <div><dt>{t('workspaces')}</dt><dd>{known ? t('slotsOf', { n: String(info.workspaces.length), max: String(SANDBOX_CAPACITY) }) : t('notReported')}</dd></div>
      <div><dt>{t('sbUncaptured')}</dt><dd data-tone={overlayDirty(changes) ? 'warning' : undefined}>{changes == null ? t('notReported') : overlayDirty(changes) ? t('sbOverlayCounts', { entries: String(changes.entries), inodes: String(changes.inodes) }) : t('none')}</dd></div>
      <div><dt>{t('sbRuntimeLine')}</dt><dd>{[info.runtime ?? info.backend, info.route, info.platform].filter(Boolean).join(' · ') || t('notReported')}</dd></div>
      <div><dt>{t('image')}</dt><dd className={native ? undefined : css.mono} title={info.image ?? undefined}>{native ? t('sbHostFs') : shortImage(info.image)}</dd></div>
    </dl>
  )
}

/** The mount map beside the selected Workspace. */
function SandboxBody({ info, onChanged }: { info: SandboxInfo, onChanged: () => void }): ReactNode {
  const { t } = useMachinesContext()
  const known = !info.refusal && !info.unread && !info.downReason
  const workspaces = known ? info.workspaces : []
  const rows = mountRows(workspaces)
  // the map's order (by mount path), not sandbox.get's: the first row is the one selected first
  const first = rows.find((r) => r.ws)?.ws?.ws ?? null
  const [selected, setSelected] = useState<string | null>(first)
  useEffect(() => {
    if (!workspaces.some((w) => w.ws === selected)) setSelected(first)
  }, [workspaces, selected, first])
  const ws = workspaces.find((w) => w.ws === selected) ?? null
  const native = info.backend === 'native' || info.runtime === 'host_process'
  return (
    <div className={css.sbFrame}>
    <Card className={css.sbBody}>
      <nav className={css.mountMap} aria-label={t('sbMountMap')}>
        <div className={css.columnHead}><span className={css.columnTitle}>{t('sbFilesystem')}</span></div>
        <ul className={css.mountRows}>
          <li className={css.mountRow} style={{ ['--depth' as string]: 0 }}>
            <IconFolderCloseRegular size={14} /><span className={css.mono}>/</span>
            <span className={css.muted}>{native ? t('sbRootHost') : t('sbRootImage')}</span>
          </li>
          {rows.map((row) => row.ws
            ? <MountButton key={row.key} ws={row.ws} label={row.label} depth={row.depth} selected={row.ws.ws === selected} onSelect={() => setSelected(row.ws!.ws)} />
            : (
              <li key={row.key} className={css.mountRow} style={{ ['--depth' as string]: row.depth }} title={row.key}>
                <IconFolderCloseRegular size={14} /><span className={css.mono}>{row.label}</span>
              </li>
            ))}
        </ul>
      </nav>
      <div className={css.wsSide}>
        {ws
          ? <WorkspacePane key={ws.ws} info={info} ws={ws} onChanged={onChanged} />
          : <Empty title={t('sbNoWorkspaceTitle')}>{info.downReason ? t('wsUnavailable', { reason: info.downReason }) : t('sbNoWorkspaceBody')}</Empty>}
      </div>
    </Card>
    </div>
  )
}

function MountButton({ ws, label, depth, selected, onSelect }: { ws: WorkspaceInfo, label: string, depth: number, selected: boolean, onSelect: () => void }): ReactNode {
  const { t } = useMachinesContext()
  const changes = overlayCount(ws.dirty)
  return (
    <li style={{ ['--depth' as string]: depth }}>
      <button type="button" className={clsx(css.mountRow, css.mountWs)} aria-current={selected || undefined} onClick={onSelect} title={ws.path}>
        <SandboxGlyph size={14} />
        <span className={css.mono}>{label}</span>
        <span className={css.mountName}>{workspaceName(ws)}</span>
        {changes > 0 && <span className={css.mountBadge} title={t('sbOverlayCounts', { entries: String(ws.dirty!.entries), inodes: String(ws.dirty!.inodes) })}>{changes}</span>}
        {ws.pendingMerge && <span className={css.mountBadge} data-tone="warning">{t('wsMergePending')}</span>}
      </button>
    </li>
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
