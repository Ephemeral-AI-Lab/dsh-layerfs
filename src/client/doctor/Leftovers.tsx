/**
 * What interrupted work left in the home (LayerFS 2.0 `home leftovers`), below
 * the Doctor page's tabs. Finding them walks every ready machine's folders, so
 * nothing is read until Look for leftovers is pressed. Each row is a dot and
 * a word (its kind) with its machine, path, size and age; the tip says when
 * LayerFS lets it go; the one action is Remove (`home prune <leftover>`),
 * left off for one LayerFS only reports or keeps until `removable_at`.
 * Machines LayerFS could not walk are one line each (`not_listed`).
 */
import { useState, type ReactNode } from 'react'
import type { LayerfsApi } from '../api.ts'
import { bytes } from '../files/format.ts'
import type { DoctorKey, DoctorT } from './locale.ts'
import { Btn } from './Row.tsx'
import { markDot } from './tips.tsx'
import css from './DoctorPage.module.css'

interface Leftover { leftover: string, modified_at?: string, size?: number | null, report_only?: boolean, removable_at?: string | null, kind?: string, machine?: string, path?: string }
interface NotListed { machine: string, message?: string, reason?: string, blocked_by?: { reason?: string } }
interface Listing { items: Leftover[], notListed: NotListed[], at: number }

const msOf = (v: string | null | undefined): number | null => { const at = v ? Date.parse(v) : NaN; return Number.isFinite(at) ? at : null }
const KIND_KEY: Record<string, DoctorKey> = {
  run_folder: 'loKindRunFolder', empty_root: 'loKindEmptyRoot', init_copy: 'loKindInitCopy',
  backup_staging: 'loKindBackupStaging', image_tmp: 'loKindImageTmp', export_container: 'loKindExportContainer',
}

export function Leftovers({ api, t }: { api: LayerfsApi, t: DoctorT }): ReactNode {
  const [listing, setListing] = useState<Listing | null>(null)
  const [looking, setLooking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const look = () => {
    setLooking(true); setError(null)
    api.call<Listing>('GET', '/api/doctor/leftovers').then(setListing, (e: any) => setError(String(e?.code ?? 'Failed'))).finally(() => setLooking(false))
  }
  const remove = (id: string) => {
    setRemoving(id); setError(null)
    api.call('POST', '/api/doctor/leftovers/prune', { leftover: id })
      .then(() => setListing((l) => l && { ...l, items: l.items.filter((x) => x.leftover !== id) }), (e: any) => setError(String(e?.code ?? 'Failed')))
      .finally(() => setRemoving(null))
  }
  const now = Date.now()
  const place = (m: string | undefined) => (m === 'native' || !m ? t('loHome') : m)
  return (
    <section className={css.leftovers} aria-label={t('loTitle')} data-leftovers="">
      <div className={css.leftoversHead}>
        <h2 className={css.leftoversTitle}>{t('loTitle')}{listing ? ` · ${listing.items.length}` : ''}</h2>
        <Btn fid="leftovers-look" busy={looking} onPress={look} tip={{ title: t('loLook'), lines: [t('loLookTip')], cmds: ['layerfs home leftovers'] }}>{t('loLook')}</Btn>
      </div>
      {error ? <p className={css.none} role="alert">{markDot('bad')} {t('loRefused', { code: error })}</p> : null}
      {listing && !listing.items.length && !listing.notListed.length ? <p className={css.none}>{markDot('ok')} {t('loNone')}</p> : null}
      {listing?.items.length ? (
        <ul className={css.leftoverList}>
          {listing.items.map((l) => {
            const until = msOf(l.removable_at)
            const waits = until !== null && until > now
            const kind = l.kind ?? l.leftover.split(':')[1] ?? ''
            const word = KIND_KEY[kind] ? t(KIND_KEY[kind]!) : kind.replace(/_/g, ' ')
            const modified = msOf(l.modified_at)
            const facts = [place(l.machine ?? l.leftover.split(':')[0]), typeof l.size === 'number' ? bytes(l.size) : t('loSizeNone'), modified !== null ? new Date(modified).toLocaleString() : null].filter(Boolean).join(' · ')
            const why = l.report_only ? t('loReportOnly') : waits ? t('loWaits', { time: new Date(until!).toLocaleString() }) : t('loRemoveTip')
            return (
              <li key={l.leftover} className={css.leftoverRow} data-leftover={l.leftover} title={why}>
                {markDot(l.report_only ? 'nc' : 'warn')}
                <span className={css.leftoverWord}>{word}</span>
                <span className={css.leftoverFacts}>{facts}</span>
                {l.path ? <code className={css.leftoverPath}>{l.path}</code> : null}
                {l.report_only || waits ? null : (
                  <Btn fid={`leftover:${l.leftover}`} busy={removing === l.leftover} off={removing !== null && removing !== l.leftover} onPress={() => remove(l.leftover)}
                    tip={{ title: t('loRemove'), lines: [why], cmds: [`layerfs home prune ${l.leftover}`] }}>{t('loRemove')}</Btn>
                )}
              </li>
            )
          })}
        </ul>
      ) : null}
      {listing?.notListed.map((n) => (
        <p key={n.machine} className={css.none} data-leftover-unlisted={n.machine}>{markDot('nc')} {t('loNotWalked', { machine: place(n.machine), reason: (n.blocked_by?.reason ?? n.reason ?? '').replace(/_/g, ' ') })}</p>
      ))}
    </section>
  )
}
