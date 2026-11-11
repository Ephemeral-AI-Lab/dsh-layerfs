/** The board's Details tab: where the home's bytes are, by Store and by place, and backup coverage. */
import type { ReactNode } from 'react'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { Card, Fact, Facts, LinkButton, Section } from '../ui/index.tsx'
import type { StorageT } from './locale.ts'
import { coverageOf, inHome } from './model.ts'
import type { StorageView } from './types.ts'
import css from './Storage.module.css'

const NEVER_SHOWN = 6

export function StorageDetails({ view, t, now, onOpenStore, onOpenMachine }: { view: StorageView, t: StorageT, now: number, onOpenStore: (name: string) => void, onOpenMachine: (name: string) => void }): ReactNode {
  const { sqlite, backed, never, oldest } = coverageOf(view)
  const pg = view.stores.filter((s) => s.kind === 'postgresql')
  const sized = [...sqlite].sort((a, b) => (b.size?.bytes ?? -1) - (a.size?.bytes ?? -1) || a.name.localeCompare(b.name))
  const total = sqlite.reduce((n, s) => n + (s.size?.bytes ?? 0), 0)
  const largest = Math.max(1, ...sqlite.map((s) => s.size?.bytes ?? 0))
  const places = [...sqlite.reduce((m, s) => {
    const place = inHome(s) ? '' : (s.machine ?? '?')
    const p = m.get(place) ?? { stores: 0, bytes: 0, projects: 0 }
    m.set(place, { stores: p.stores + 1, bytes: p.bytes + (s.size?.bytes ?? 0), projects: p.projects + s.projects.length })
    return m
  }, new Map<string, { stores: number, bytes: number, projects: number }>())].sort((a, b) => b[1].bytes - a[1].bytes)
  return (
    <>
      <Section title={t('detailsBySize')} count={sqlite.length === 1 ? t('detailsBySizeSubOne', { size: bytes(total) }) : t('detailsBySizeSub', { size: bytes(total), n: sqlite.length })}>
        <Card className={css.tableCard}>
          {sized.length ? (
            <table className={css.table}>
              <thead><tr><th>{t('colStore')}</th><th>{t('colPlace')}</th><th className={css.wide}>{' '}</th><th className={css.num}>{t('colSize')}</th><th className={`${css.num} ${css.wide}`}>{t('colFileWal')}</th></tr></thead>
              <tbody>
                {sized.map((s) => (
                  <tr key={s.name}>
                    <td><LinkButton onClick={() => onOpenStore(s.name)}>{s.name}</LinkButton></td>
                    <td className={css.muted}>{inHome(s) ? t('layerfsHome') : s.machine}</td>
                    <td className={css.wide}>{s.size ? <span className={css.bar}><span className={css.barFill} style={{ width: `${(s.size.bytes / largest) * 100}%` }} /></span> : null}</td>
                    <td className={css.num}>{s.size ? bytes(s.size.bytes) : <span className={css.muted}>{t('unavailable')}</span>}</td>
                    <td className={`${css.num} ${css.wide} ${css.muted}`}>{s.size ? `${bytes(s.size.file)} · ${bytes(s.size.wal)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className={css.cardEmpty}>{t('noSqlite')}</p>}
        </Card>
      </Section>
      <div className={css.twoCol}>
        <Section title={t('detailsByPlace')}>
          <Card className={css.tableCard}>
            <table className={css.table}>
              <thead><tr><th>{t('colPlace')}</th><th className={css.num}>{t('colStores')}</th><th className={css.num}>{t('colProjects')}</th><th className={css.num}>{t('colSize')}</th></tr></thead>
              <tbody>
                {places.map(([place, p]) => (
                  <tr key={place || 'home'}>
                    <td>{place ? <LinkButton onClick={() => onOpenMachine(place)}>{place}</LinkButton> : t('layerfsHome')}</td>
                    <td className={css.num}>{p.stores}</td>
                    <td className={css.num}>{p.projects}</td>
                    <td className={css.num}>{bytes(p.bytes)}</td>
                  </tr>
                ))}
                <tr>
                  <td>{t('postgresql')}</td>
                  <td className={css.num}>{pg.length}</td>
                  <td className={css.num}>{pg.reduce((n, s) => n + s.projects.length, 0)}</td>
                  <td className={`${css.num} ${css.muted}`}>—</td>
                </tr>
              </tbody>
            </table>
          </Card>
        </Section>
        <Section title={t('detailsCoverage')}>
          <Card>
            <div className={css.coverage}>
              <span className={css.bar}><span className={css.barFill} data-tone={never.length ? 'warning' : undefined} style={{ width: `${sqlite.length ? (backed.length / sqlite.length) * 100 : 0}%` }} /></span>
              <span>{t('coverage', { backed: backed.length, total: sqlite.length })}</span>
            </div>
            <Facts>
              <Fact label={t('oldestBackup')}>{oldest !== null ? ago(oldest, now, t as Translate) : null}</Fact>
              <Fact label={t('neverBackedUp')}>
                {!never.length ? t('none') : never.length === sqlite.length && never.length > 1 ? t('allStores', { n: never.length }) : (
                  <span className={css.linkList}>
                    {never.slice(0, NEVER_SHOWN).map((s) => <LinkButton key={s.name} onClick={() => onOpenStore(s.name)}>{s.name}</LinkButton>)}
                    {never.length > NEVER_SHOWN ? <span className={css.muted}>{t('moreCount', { n: never.length - NEVER_SHOWN })}</span> : null}
                  </span>
                )}
              </Fact>
            </Facts>
          </Card>
        </Section>
      </div>
    </>
  )
}
