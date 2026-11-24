/**
 * A PostgreSQL Store's page (docs/specs/store-home-rows.md "Store page"):
 * the header (name, `PostgreSQL · size · N projects`, Check, ⋯ with
 * Disconnect… and Copy address), then two columns: every project (largest
 * first, with a link to the Projects tab filtered by this Store), and beside
 * them the saved Connection and the machines it Runs on.
 */
import { useState, type ReactNode } from 'react'
import { Button, IconPlusOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { StatusDot } from '../ui/StatusDot.tsx'
import { enc, type LayerfsApi } from '../api.ts'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { useProjectMachines } from '../projects/hooks.ts'
import { MoreMenu, Notice, PageHead, StateChip } from '../ui/index.tsx'
import { useQuery } from '../ui/use-query.ts'
import type { StorageT } from './locale.ts'
import { pgStoreBytes, storeStateWords, storeTone } from './model.ts'
import { StoreGlyph } from './parts.tsx'
import { filterProjectsBy } from './ProjectFinder.tsx'
import type { StoreActions } from './StoreCard.tsx'
import type { StoreStats } from './store-page.ts'
import { hostStatus, pgAddress } from './store-rows.ts'
import { CopyAddress, ProjectsList, ReachWord, RunsOnList } from './StoreRows.tsx'
import type { TabId } from './tabs.ts'
import type { StorageView, StoreRow } from './types.ts'
import css from './PgStorePage.module.css'
import rowsCss from './StoreRows.module.css'

export function PgStorePage({ s, view, t, api, now, on, onOpenProject, onOpen }: {
  s: StoreRow, view: StorageView, t: StorageT, api: LayerfsApi, now: number, on: StoreActions
  onOpenProject: (key: string) => void, onOpen?: ((id: TabId) => void) | undefined
}): ReactNode {
  const tt = t as Translate
  const machines = useProjectMachines(api)
  const sandboxes = machines.data?.available ? machines.data.sandboxes : undefined
  const stats = useQuery(() => api.call<StoreStats>('GET', `/api/stores/${enc(s.name)}/stats`), [api, s.name], { refresh: [s.projects.length], cache: `store-stats:${s.name}` })
  const [checking, setChecking] = useState(false)
  const check = () => { if (checking) return; setChecking(true); void Promise.resolve(on.check()).finally(() => setChecking(false)) }
  const size = pgStoreBytes(stats.data)
  const projects = s.projectsCount ?? s.projects.length
  const pg = s.postgresql
  const address = pgAddress(s)
  const host = hostStatus(s, checking)
  const busy = (sandboxes ?? []).filter((b) => b.project?.startsWith(`${s.name}/`)).length
  const checkingSides = new Set(checking ? (s.attached ?? []).map((a) => a.machine) : [])
  const details = [pg?.synchronousCommit ? t('pgSyncCommit', { value: pg.synchronousCommit }) : t('pgSyncCommitDefault'), pg?.binding ? t('pgStoreId', { id: pg.binding }) : null].filter(Boolean).join('\n')
  return (
    <>
      <PageHead title={s.name} icon={<StoreGlyph kind="postgresql" size={22} />}
        badge={s.state !== 'ready' ? <StateChip tone={storeTone(s.state, s.blockedBy)} label={storeStateWords(s.state, t)} live={s.state === 'busy'} /> : undefined}
        intro={<span className={css.intro}>{[t('postgresql'), size !== null ? bytes(size) : null, t(projects === 1 ? 'msProjectOne' : 'msProjectCount', { n: projects })].filter(Boolean).join(' · ')}</span>}
        actions={(
          <>
            <Button variant="outline" size="sm" disabled={checking} onClick={check} icon={checking ? <StatusDot state="ongoing" size={13} /> : undefined}>{checking ? t('stChecking') : t('pgCheck')}</Button>
            <MoreMenu label={t('storeActions', { name: s.name })}>
              {(close) => (
                <>
                  <MenuItemButton disabled={!pg?.url} onSelect={() => { close(); void navigator.clipboard?.writeText(pg?.url ?? '').catch(() => {}) }}>{t('rowCopyAddress')}</MenuItemButton>
                  <MenuItemButton danger separatorBefore disabled={busy > 0} disabledReason={busy ? t('pgDisconnectBusy', { n: busy }) : undefined}
                    onSelect={() => { close(); on.disconnect() }}>{t('disconnect')}</MenuItemButton>
                </>
              )}
            </MoreMenu>
          </>
        )} />
      {s.state === 'broken' && s.reason !== 'unreachable' ? <Notice tone="danger" role="alert"><span title={s.message ?? s.fix ?? undefined}>{storeStateWords(s.state, t, s.reason)}</span></Notice> : null}
      <div className={css.columns}>
        <div className={css.main}>
          <ProjectsList api={api} s={s} t={t} now={now} sandboxes={sandboxes} onOpenProject={onOpenProject} onOpenStore={() => {}} stale={host.tone === 'danger'} cap={null} />
          {projects > 0 && onOpen ? (
            <button type="button" className={rowsCss.link} onClick={() => { filterProjectsBy(s.name); onOpen('overview') }}>{t('pgProjectsTab')}</button>
          ) : null}
        </div>
        <div className={css.side}>
          <section className={css.card} aria-label={t('connection')}>
            <div className={rowsCss.sectionHead}>
              <span className={rowsCss.sectionTitle} title={details}>{t('connection')}</span>
              <button type="button" className={rowsCss.link} onClick={on.editConnection}>{t('pgEditShort')}</button>
            </div>
            <dl className={css.facts}>
              <dt>{t('pgAddress')}</dt>
              <dd className={css.addr} title={address ?? undefined}>
                <span className={rowsCss.mono}>{pg?.server ?? '—'}</span>{pg?.url ? <CopyAddress text={pg.url} t={t} /> : null}
              </dd>
              <dt>{t('pgDatabase')}</dt>
              <dd className={rowsCss.mono} title={pg?.database ? [pg.database, pg.binding ? t('pgStoreId', { id: pg.binding }) : null].filter(Boolean).join('\n') : undefined}>{pg?.database ?? '—'}</dd>
              <dt>{t('pgUser')}</dt>
              <dd className={rowsCss.mono}>{pg?.user ?? '—'}</dd>
              <dt>{t('pgPasswordValue')}</dt>
              <dd title={pg?.passwordChangedAt ? t('pgPasswordChanged', { when: ago(pg.passwordChangedAt, now, tt) }) : undefined}>
                {pg?.passwordSaved === true ? t('pgPasswordSaved') : pg?.passwordSaved === false ? t('pgPasswordNotSaved') : '—'}
              </dd>
              <dt>{t('pgHostCheck')}</dt>
              <dd className={css.check}>
                <ReachWord status={host} t={t} onEdit={on.editConnection} when={pg?.host?.at ? ago(pg.host.at, now, tt) : null} />
              </dd>
            </dl>
          </section>
          <section className={css.card} aria-label={t('rowRunsOn')}>
            <div className={rowsCss.sectionHead}>
              <span className={rowsCss.sectionTitle}>{t('rowRunsOn')}</span>
              <button type="button" className={rowsCss.link} onClick={on.attach}><IconPlusOutlineRegular size={10} />{t('rowAttachMachine')}</button>
            </div>
            <RunsOnList s={s} view={view} t={t} on={on} checking={checkingSides} sandboxes={sandboxes} />
          </section>
        </div>
      </div>
    </>
  )
}
