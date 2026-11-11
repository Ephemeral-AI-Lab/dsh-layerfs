/**
 * The machine page's Stores tab: the Stores its Sandboxes can use, one card
 * each. A sqlite Store on its disk, and the PostgreSQL Stores its Sandboxes
 * reach (every one, when the machine runs PostgreSQL Sandboxes; else
 * LayerFS's reason under them). Pushing, pulling and moving Stores stay on
 * Storage, which each Store opens.
 */
import type { ReactNode } from 'react'
import { IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, StateChip } from '../ui/index.tsx'
import { STORAGE_PANEL } from './Board.tsx'
import { useMachinesContext } from './context.tsx'
import { StoreGlyph } from './icons.tsx'
import { bytes, opWords, stateLook, type MachineInfo, type MachinePgStore, type MachineSandbox, type MachineStore, type SdkOperation } from './model.ts'
import css from './machines.module.css'

/** How many Stores the machine's Sandboxes can use. */
export function storeCount(m: MachineInfo, sqlite: MachineStore[], postgresql: MachinePgStore[]): number {
  return sqlite.length + (m.supports?.postgresql_sandbox ? postgresql.length : 0)
}

export function StoresTab({ m, sqlite, postgresql, sandboxes }: { m: MachineInfo, sqlite: MachineStore[], postgresql: MachinePgStore[], sandboxes: MachineSandbox[] }): ReactNode {
  const { t } = useMachinesContext()
  const reach = m.supports?.postgresql_sandbox
  const pg = reach ? postgresql : []
  const note = reach === false
    ? (m.supports?.reason ?? t('pgNotHere'))
    : reach === undefined && postgresql.length > 0 ? t('pgUnknown') : null
  const noteLine = note && <p className={css.footnote}>{t('pgNote', { note })}</p>
  if (sqlite.length + pg.length === 0) {
    return <div className={css.groups}><p className={css.emptyLine}>{t('storesEmpty')}</p>{noteLine}</div>
  }
  return (
    <div className={css.groups}>
      <div role="list" aria-label={t('stores')} className={css.groups}>
        {sqlite.map((s) => <StoreGroup key={s.name} s={s} kind={t('storeSqliteOn', { machine: m.name })} size={s.size} m={m} sandboxes={sandboxes} />)}
        {pg.map((s) => <StoreGroup key={s.name} s={s} kind={t('storePgReached')} size={null} m={m} sandboxes={sandboxes} />)}
      </div>
      {noteLine}
    </div>
  )
}

function StoreGroup({ s, kind, size, m, sandboxes }: {
  s: { name: string, state?: string, op?: SdkOperation | null, names?: string[], projects: number }
  kind: string
  size: number | null
  m: MachineInfo
  sandboxes: MachineSandbox[]
}): ReactNode {
  const { t, stateWord, openPanel } = useMachinesContext()
  const look = stateLook('store', s.state)
  const open = () => openPanel(STORAGE_PANEL)
  return (
    <Card role="listitem" aria-label={s.name} className={css.group}>
      <header className={css.groupHead}>
        <span className={css.groupIcon} aria-hidden="true"><StoreGlyph size={16} /></span>
        <div className={css.groupTitleBlock}>
          <h3 className={css.groupTitle}>
            <button type="button" className={css.cardOpen} onClick={open} aria-label={t('openStore', { name: s.name })}>{s.name}</button>
          </h3>
          <span className={css.groupSub}>{kind}</span>
        </div>
        <span className={css.groupMeta}>
          {(s.op || (s.state && s.state !== 'idle')) && <StateChip tone={look.tone} live={look.live} dashed={look.dashed} label={stateWord(look)} op={opWords(s.op)} />}
          {size != null && <span className={css.mono}>{bytes(size)}</span>}
        </span>
        <IconChevronRightOutlineRegular size={14} className={css.groupArrow} aria-hidden="true" />
      </header>
      <div className={css.groupBody}>
        {s.names?.length
          ? (
            <table className={css.rows}>
              <thead><tr><th>{t('project')}</th><th>{t('sandboxesOn', { machine: m.name })}</th></tr></thead>
              <tbody>
                {s.names.map((p) => {
                  const key = `${s.name}/${p}`
                  const here = sandboxes.filter((b) => b.project === key)
                  return (
                    <tr key={p}>
                      <td>{p}</td>
                      <td className={here.length ? undefined : css.muted} title={here.map((b) => b.name).join(', ') || undefined}>{here.length ? here.map((b) => b.name).join(', ') : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )
          : <p className={css.groupEmpty}>{s.projects > 0 ? t(s.projects === 1 ? 'projectsUnnamedOne' : 'projectsUnnamed', { n: String(s.projects) }) : t('noProjects')}</p>}
      </div>
    </Card>
  )
}
