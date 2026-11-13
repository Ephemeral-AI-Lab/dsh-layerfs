/**
 * One Sandbox's page (sandbox.get): its state, the daemon line, and its
 * Workspaces as terminals (SandboxTerminals.tsx); the record's other fields
 * and the daemon's retained failures fold away under Record details.
 *
 * Delete is sandbox.close, with an explicit Force delete action. A Sandbox
 * whose machine differs from the one it was opened from is refused here.
 */
import type { ReactNode } from 'react'
import { Button, IconChevronRightOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { DoctorAction } from '../doctor/Doctor.tsx'
import { Card, Fact, Facts, LoadError, Loading, Notice, Page, PageHead, Refusal, StateChip } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { SandboxGlyph } from './icons.tsx'
import { useMachineTitle } from './Inventory.tsx'
import type { View } from './context.tsx'
import { clearingCall, daemonLook, daemonSlots, opWords, stateLook, type SandboxInfo } from './model.ts'
import { SandboxMenu, useClose, useSandboxRead } from './Sandboxes.tsx'
import { SandboxTerminals } from './SandboxTerminals.tsx'
import css from './machines.module.css'
import term from './terminal.module.css'

export function SandboxDetail({ machine, name, go }: { machine: string, name: string, go: (view: View) => void }): ReactNode {
  const { t, stateWord, refusal, kind, api, doctorT, useMachines } = useMachinesContext()
  const listed = useMachines((s) => (s.data?.available ? s.data.sandboxes.find((b) => b.name === name) : undefined))
  const parent = useMachines((s) => (s.data?.available ? s.data.machines.find((m) => m.name === machine) : undefined))
  const detail = useSandboxRead(name, listed?.state, listed?.workspaces)
  const closing = useClose(name)
  const title = useMachineTitle()
  const machineTitle = title({ name: machine, platform: parent?.platform ?? (machine === 'native' ? 'native' : '') })
  const crumbs = [
    { label: t('panel'), ariaLabel: t('backToMachines'), onClick: () => go({ kind: 'board' }) },
    { label: machineTitle, onClick: () => go({ kind: 'machine', name: machine }) },
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
    t('sbOnMachine', { machine: machineTitle, kind: parent ? kind(parent.platform) : info.platform ?? '—' }),
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

      <DaemonLine info={info} />

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

      <SandboxTerminals info={info} onChanged={detail.reload} />

      <details className={css.details}>
        <summary className={css.detailsSummary}><IconChevronRightOutlineRegular size={12} className={css.detailsChevron} /><span>{t('sbDetails')}</span></summary>
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

/** The daemon in one line: reachable or not, its free control slots and retained failures. */
function DaemonLine({ info }: { info: SandboxInfo }): ReactNode {
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
