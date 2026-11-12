/**
 * One Sandbox's page (sandbox.get): its state and operation, its machine,
 * project, image and route, and its mounted Workspaces. Delete is
 * sandbox.close, with an explicit Force delete action. A Sandbox
 * whose machine differs from the one it was opened from is refused here.
 */
import type { ReactNode } from 'react'
import { Button, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { DoctorAction } from '../doctor/Doctor.tsx'
import { Card, Fact, Facts, LinkButton, LoadError, Loading, Notice, Page, PageHead, Refusal, Section, StateChip } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { SandboxGlyph } from './icons.tsx'
import type { View } from './context.tsx'
import { SANDBOX_CAPACITY, clearingCall, opWords, shortImage, stateLook, workspaceChanges, workspaceName } from './model.ts'
import { SandboxMenu, useClose, useSandboxRead } from './Sandboxes.tsx'
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
  const workspacesKnown = !info.refusal && !info.unread && !info.downReason
  return (
    <Page wide label={name}>
      <PageHead
        crumbs={crumbs}
        current={name}
        icon={<SandboxGlyph size={22} />}
        title={name}
        badge={<StateChip tone={look.tone} live={look.live} dashed={look.dashed} label={stateWord(look)} op={op} title={op ? t(info.op?.uncertain ? 'opTitleUncertain' : 'opTitle', { op }) : undefined} />}
        intro={info.project ? t('sandboxProject', { project: info.project }) : t('noProject')}
        actions={(
          <>
            <DoctorAction api={api} t={doctorT} target="sandbox" name={name} label={doctorT('diagnose')} />
            <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />} onClick={detail.reload}>{t('refresh')}</Button>
            <SandboxMenu name={name} op={info.op ?? null} closing={closing} onDeleted={() => go({ kind: 'machine', name: machine })} />
          </>
        )}
      />
      {(info.refusal || detail.error != null || calls || closing.error !== null || !!closing.unknown?.length) && (
        <Notice tone="danger">
          {info.refusal && <Refusal error={info.refusal} labels={refusal} compact />}
          {detail.error != null && <Refusal error={detail.error} labels={refusal} compact />}
          {calls && <p><code>{t('clearingCall', { status: calls.status, clear: calls.clear })}</code></p>}
          {closing.error !== null && <Refusal error={closing.error} labels={refusal} />}
          {!!closing.unknown?.length && <p>{t('forceClosedUnknown', { list: closing.unknown.join(', ') })}</p>}
        </Notice>
      )}

      <Section title={t('overview')}>
        <Card>
          <Facts>
            <Fact label={t('parentMachine')}>
              <LinkButton onClick={() => go({ kind: 'machine', name: machine })}>{machine}</LinkButton>
              {parent && <span className={css.factSub}>{kind(parent.platform)}</span>}
            </Fact>
            <Fact label={t('project')} mono>{info.project}</Fact>
            <Fact label={t('image')} mono title={info.image ?? undefined}>{info.image ? shortImage(info.image) : info.backend === 'native' ? t('imageNone') : null}</Fact>
            <Fact label={t('filesystemRoute')}>{info.route}</Fact>
            <Fact label={t('runtime')}>{info.runtime ?? info.backend}</Fact>
            {info.platform && <Fact label={t('platform')}>{info.platform}</Fact>}
            {info.created != null && <Fact label={t('created')}>{new Date(info.created < 1e12 ? info.created * 1000 : info.created).toLocaleString()}</Fact>}
            {info.runtimeId && <Fact label={t('runtimeReference')} mono>{info.runtimeId}</Fact>}
            {info.downReason && <Fact label={t('downBecause')} tone="danger">{info.downReason}</Fact>}
          </Facts>
        </Card>
      </Section>

      <Section title={t('workspaces')} count={workspacesKnown ? t('wsSlots', { n: String(info.workspaces.length), cap: String(SANDBOX_CAPACITY) }) : t('wsStatusUnavailable')}>
        {workspacesKnown && info.workspaces.length > 0
          ? (
            <Card className={css.tableCard}>
              <table className={css.rows}>
                <thead>
                  <tr><th>{t('name')}</th><th>{t('branch')}</th><th className={css.colWide}>{t('mountPath')}</th><th>{t('changes')}</th></tr>
                </thead>
                <tbody>
                  {info.workspaces.map((ws) => {
                    const c = workspaceChanges(ws)
                    return (
                      <tr key={ws.ws}>
                        <td title={ws.ws}>{workspaceName(ws)}</td>
                        <td className={css.muted}>{ws.branch || t('notReported')}</td>
                        <td className={css.colWide}><span className={css.mono}>{ws.path}</span></td>
                        <td data-tone={c.tone}>{t(c.key, c.values)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Card>
          )
          : <p className={css.emptyLine}>{info.downReason ? t('wsUnavailable', { reason: info.downReason }) : t('wsNoneMounted')}</p>}
      </Section>
    </Page>
  )
}
