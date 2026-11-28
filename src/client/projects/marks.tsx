/**
 * A project's marks, borrowed from Home's project table: its Store's kind
 * (SQLite or PostgreSQL) and the machine it runs on. A PostgreSQL Store can be
 * attached to several machines: the first one's mark shows with "+N", and the
 * tip names every machine.
 */
import type { ReactNode } from 'react'
import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import { isHostName } from '../../shared/host-machine.ts'
import { MachineGlyph, StoreKindGlyph } from '../machines/icons.tsx'
import type { ProjectItem } from './ProjectList.tsx'
import type { ListT } from './list-locale.ts'
import css from './list.module.css'

/** The host computer's OS as `/api/storage` reports it. */
export type HostOs = 'macos' | 'linux' | 'windows' | 'other' | undefined

/** How the parts below name and draw machines. */
export interface MarkContext { t: ListT, platformOf: (machine: string) => string, hostOs: HostOs }

const glyphOs = (os: HostOs): 'mac' | 'linux' | 'pc' => (os === 'linux' ? 'linux' : os === 'windows' || os === 'other' ? 'pc' : 'mac')

/** "This Mac" for the host machine, else its name. */
export function machineLabel(machine: string, ctx: MarkContext): string {
  if (!isHostName(machine)) return machine
  return ctx.t(ctx.hostOs === 'windows' ? 'hostPc' : ctx.hostOs === 'linux' ? 'hostLinux' : 'hostMac')
}

/** The Store's kind: the Store row when Storage has been read, else the catalog's. */
export const storeKind = (item: ProjectItem): string => item.store?.kind ?? item.row.kind ?? 'sqlite'

export function MachineMark({ machine, ctx, size = 14 }: { machine: string, ctx: MarkContext, size?: number }): ReactNode {
  return <MachineGlyph platform={isHostName(machine) ? 'host' : ctx.platformOf(machine)} os={isHostName(machine) ? glyphOs(ctx.hostOs) : undefined} size={size} />
}

/** "Store demo-studio (SQLite) · runs on docker, lima-a" for a tip. */
export function marksTip(item: ProjectItem, ctx: MarkContext): string {
  const store = item.row.store ?? item.row.key.split('/')[0] ?? ''
  const kind = ctx.t(storeKind(item) === 'postgresql' ? 'kindPg' : 'kindSqlite')
  return item.runsOn.length
    ? ctx.t('marksTip', { store, kind, machines: item.runsOn.map((m) => machineLabel(m, ctx)).join(', ') })
    : ctx.t('marksTipStore', { store, kind })
}

/** The sidebar row's trailing marks: Store kind, first machine and "+N". */
export function ProjectMarks({ item, ctx }: { item: ProjectItem, ctx: MarkContext }): ReactNode {
  const [first, ...rest] = item.runsOn
  return <span className={css.marks} data-project-marks="">
    <StoreKindGlyph kind={storeKind(item)} size={13} />
    {first ? <MachineMark machine={first} ctx={ctx} size={13} /> : null}
    {rest.length ? <span className={css.moreMachines}>{ctx.t('moreMachines', { n: rest.length })}</span> : null}
  </span>
}

/** "2 h ago" in the list's words. */
export function ago(at: number, t: ListT): string {
  const r = relativeTime(at, Date.now())
  switch (r.unit) {
    case 'minutes': return t('agoMinutes', { n: r.n })
    case 'hours': return t('agoHours', { n: r.n })
    case 'days': return t('agoDays', { n: r.n })
    case 'months': return t('agoMonths', { n: r.n })
    case 'years': return t('agoYears', { n: r.n })
    default: return t('agoNow')
  }
}

/** "2h" for the sidebar row. */
export function shortAgo(at: number, t: ListT): string {
  const r = relativeTime(at, Date.now())
  switch (r.unit) {
    case 'minutes': return t('shortMinutes', { n: r.n })
    case 'hours': return t('shortHours', { n: r.n })
    case 'days': return t('shortDays', { n: r.n })
    case 'months': return t('shortMonths', { n: r.n })
    case 'years': return t('shortYears', { n: r.n })
    default: return t('shortNow')
  }
}
