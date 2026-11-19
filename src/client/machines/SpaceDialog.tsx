/**
 * "Where the disk goes" as a dialog over the machine page (opened from the
 * Overview's Usage card and the disk notice; there is no Disk tab): free of
 * total, one bar split by part, LayerFS's parts with what frees each, what is
 * not LayerFS's with the command that shows it, free space and when the
 * warning starts, then the largest Stores and Sandboxes, each list leading to
 * its tab.
 *
 * Read with the machine's `machine stats --with space` (space.ts; refreshed every minute
 * while open, now on Refresh). A machine that is not running is not asked; a
 * refused read keeps the last answer with the refusal; a part LayerFS did not
 * read shows as not read, never as zero. What is not LayerFS's is only ever
 * explained: nothing here offers to remove it.
 */
import { useState, type ReactNode } from 'react'
import { Button, IconRefreshOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { LinkButton } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { SandboxGlyph } from './icons.tsx'
import { useMachineTitle } from './Inventory.tsx'
import { percent } from './metrics.ts'
import { gib, sandboxGone, shortSandbox, type MachineInfo } from './model.ts'
import {
  diskSpans, outsideCommand, outsideWords, sandboxSpaceReason, sandboxesBySize, spaceRows, spaceSize as size,
  type MachineSpace, type SpaceRow,
} from './space.ts'
import { useMachineSpace } from './SpaceViews.tsx'
import { diskScopeWords } from './stats.ts'
import css from './machines.module.css'
import { clockTime } from '../ui/locale-sync.ts'

const clock = (at: number | null): string => (at ? clockTime(at) : '—')
const pct = (share: number): string => `${(Math.max(0, Math.min(1, share)) * 100).toFixed(2)}%`
const LIST_ROWS = 5

const ROW_KEYS = {
  stores: ['spaceRowStores', 'spaceHintStores'],
  overlays: ['spaceRowOverlays', 'spaceHintOverlays'],
  sandboxFiles: ['spaceRowSandboxFiles', 'spaceHintSandboxFiles'],
  sandboxRuntime: ['spaceRowSandboxRuntime', 'spaceHintSandboxRuntime'],
  images: ['spaceRowImages', 'spaceHintImages'],
  otherRuns: ['spaceRowOtherRuns', 'spaceHintOtherRuns'],
  logs: ['spaceRowLogs', 'spaceHintLogs'],
  outside: ['spaceRowOutside', null],
  free: ['spaceRowFree', null],
} as const

/** `onTab`: closes the dialog on the Stores or Sandboxes tab. */
export function SpaceDialog({ m, onClose, onTab }: { m: MachineInfo, onClose: () => void, onTab: (tab: 'stores' | 'sandboxes') => void }): ReactNode {
  const { t, tw } = useMachinesContext()
  const title = useMachineTitle()
  const { askable, read, refresh } = useMachineSpace(m)
  const view = read.data ?? null
  const space = view?.space ?? null
  const scope = space ? diskScopeWords(space.disk.scope) : null
  const description = [space?.disk.fs, scope ? tw(scope) : null, space ? t('spaceAsOf', { time: clock(view!.at) }) : null].filter(Boolean).join(' · ')
  return (
    <Modal open onClose={onClose} title={t('spaceDialogTitle', { name: title(m) })} description={description || undefined} closeLabel={t('close')}
      className={css.spaceDialog} contentClassName={css.dialogContent}>
      <div className={css.sdBody} data-space-dialog={m.name}>
        {!askable
          ? <p className={css.muted} data-space="stopped">{t('spaceStopped')}</p>
          : !space
            ? view?.stale
              ? <p className={css.muted} data-space="refused">{t('spaceRefused', { code: view.stale.code, message: view.stale.message })}</p>
              : read.error != null
                ? <p className={css.muted} data-space="error">{t('spaceRefused', { code: (read.error as any)?.code ?? 'Unknown', message: (read.error as any)?.message ?? String(read.error) })}</p>
                : <p className={css.muted} data-space="loading">{t('spaceReading')}</p>
            : <SpaceBody m={m} space={space} onTab={onTab} />}
        {view?.stale && space && <p className={css.muted} data-space="stale">{t('spaceStale', { time: clock(view.at), code: view.stale.code, message: view.stale.message })}</p>}
        {askable && (
          <div className={css.sdActions}>
            <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={12} />} onClick={refresh} disabled={read.loading}>{t('refresh')}</Button>
          </div>
        )}
      </div>
    </Modal>
  )
}

/** The bar by part: each LayerFS part in its shade, what is not LayerFS's (or used space not split), then free. */
function PartBar({ space, rows }: { space: MachineSpace, rows: SpaceRow[] }): ReactNode {
  const { t } = useMachinesContext()
  const total = space.disk.total
  const spans = diskSpans(space)
  if (!total || !spans) return null
  const label = space.outside != null
    ? t('spaceBarLabel', { layerfs: size(space.layerfs), outside: size(space.outside), free: size(space.disk.free) })
    : t('spaceBarLabelPartial', { layerfs: size(space.layerfs), free: size(space.disk.free) })
  return (
    <span className={css.sdBar} role="img" aria-label={label} title={label} data-space-bar>
      {rows.filter((r) => r.layerfs && r.bytes != null && r.bytes > 0).map((r) => (
        <span key={r.key} className={css.sdSeg} data-part={r.key} style={{ width: pct(r.bytes! / total) }} title={`${t(ROW_KEYS[r.key][0])} ${size(r.bytes)}`} />
      ))}
      {spans.outside > 0 && <span className={css.sdSeg} data-part="outside" style={{ width: pct(spans.outside) }} />}
      {spans.unsplit > 0 && <span className={css.sdSeg} data-part="unsplit" style={{ width: pct(spans.unsplit) }} />}
    </span>
  )
}

/** One LayerFS part: swatch, what it is and what frees it, its share of LayerFS's data, its size ("at least" when the walk stopped early). */
function PartRow({ row, space }: { row: SpaceRow, space: MachineSpace }): ReactNode {
  const { t } = useMachinesContext()
  const [label, hint] = ROW_KEYS[row.key]
  const share = row.bytes != null && space.layerfs ? row.bytes / space.layerfs : 0
  return (
    <li className={css.sdRow} data-space-row={row.key}>
      <span className={css.sdRowName}>
        <span className={css.spaceSwatch} data-part={row.key} />
        <span>
          <span className={css.spaceRowLabel}>{t(label)}</span>
          {hint && <span className={css.factSub}>{t(hint)}</span>}
        </span>
      </span>
      <span className={css.sdMini}><span style={{ width: pct(share) }} data-part={row.key} /></span>
      <span className={css.sdSize} data-space-size={row.bytes ?? ''}>
        {row.bytes == null ? <span className={css.muted}>{t('spaceNotRead')}</span> : !space.complete ? t('spaceAtLeast', { size: size(row.bytes) }) : size(row.bytes)}
      </span>
    </li>
  )
}

function SpaceBody({ m, space, onTab }: { m: MachineInfo, space: MachineSpace, onTab: (tab: 'stores' | 'sandboxes') => void }): ReactNode {
  const { t, tw, go, useMachines } = useMachinesContext()
  const [copied, setCopied] = useState(false)
  const states = useMachines((s) => (s.data?.available ? s.data.sandboxes : null))
  const rows = spaceRows(space)
  const parts = rows.filter((r) => r.layerfs)
  const { total, free, used } = space.disk
  const command = outsideCommand(space.disk.scope)
  const stores = [...space.stores].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name))
  const sandboxes = sandboxesBySize(space)
  const usedBytes = used ?? (total != null && free != null ? total - free : null)
  return (
    <>
      <div className={css.sdHead}>
        <span className={css.ovValue}>{t('spaceFree', { free: gib(free) })}</span>
        {total != null && <span className={css.muted}>{t('spaceOfUsed', { total: gib(total), share: usedBytes != null && total > 0 ? percent(usedBytes / total) : '—' })}</span>}
      </div>
      <PartBar space={space} rows={rows} />
      <div className={css.ovKeys} data-space-legend>
        <span><i className={css.ovKey} data-part="layerfs" />{t('spaceKeyLayerfs', { size: size(space.layerfs) })}</span>
        {space.outside != null && <span><i className={css.ovKey} data-part="outside" />{t('ovNotLayerfs', { size: size(space.outside) })}</span>}
        <span><i className={css.ovKey} data-part="free" />{t('spaceKeyFree', { size: size(free) })}</span>
      </div>
      {!space.complete && <p className={css.spaceHint} data-space="partial">{t('spacePartial')}</p>}
      {space.unreadable > 0 && <p className={css.spaceHint} data-space="unreadable">{t('spaceUnreadable', { n: String(space.unreadable) })}</p>}

      <div className={css.sdCols}>
        <section aria-label="LayerFS">
          <h4 className={css.sdTitle}><span>LayerFS</span><span>{space.complete ? size(space.layerfs) : t('spaceAtLeast', { size: size(space.layerfs) })}</span></h4>
          <ul className={css.sdRows} data-space-breakdown>{parts.map((r) => <PartRow key={r.key} row={r} space={space} />)}</ul>
        </section>
        <div className={css.sdSide}>
          <section className={css.sdBox} data-space-row="outside">
            <h4 className={css.sdTitle}><span><span className={css.spaceSwatch} data-part="outside" />{t('spaceRowOutside')}</span><span>{space.outside != null ? size(space.outside) : t('spaceNotSplit')}</span></h4>
            <p className={css.sdText}>{tw(outsideWords(space.disk.scope))}</p>
            {command && (
              <p className={css.sdCommand}>
                <code className={css.mono}>{command}</code>
                <button type="button" className={css.spaceCopy} onClick={() => { void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => {}) }}>{t(copied ? 'copied' : 'copy')}</button>
              </p>
            )}
          </section>
          <section className={css.sdBox} data-space-row="free">
            <h4 className={css.sdTitle}><span><span className={css.spaceSwatch} data-part="free" />{t('spaceRowFree')}</span><span>{size(free)}</span></h4>
            <p className={css.sdText}>{t('spaceWarnRule')}</p>
          </section>
        </div>
      </div>

      <div className={css.sdCols} data-even>
        <section aria-label={t('spaceLargestStores')}>
          <h4 className={css.sdTitle}><span>{t('spaceLargestStores')}</span><LinkButton onClick={() => onTab('stores')}>{t('spaceStoresTab')}</LinkButton></h4>
          {stores.length === 0 ? <p className={css.sdText}>{t('noStoresHere')}</p> : (
            <ul className={css.sdRows}>
              {stores.slice(0, LIST_ROWS).map((s) => (
                <li key={s.name} className={css.sdRow} data-even data-space-store={s.name}><span className={css.sdRowText} title={s.name}>{s.name}</span><span className={css.sdSize}>{s.bytes != null ? size(s.bytes) : '—'}</span></li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label={t('spaceLargestSandboxes')}>
          <h4 className={css.sdTitle}><span>{t('spaceLargestSandboxes')}</span><LinkButton onClick={() => onTab('sandboxes')}>{t('spaceSandboxesTab')}</LinkButton></h4>
          {sandboxes.length === 0 ? <p className={css.sdText}>{t('spaceNoSandboxes')}</p> : (
            <ul className={css.sdRows}>
              {sandboxes.slice(0, LIST_ROWS).map((r) => {
                const why = r.bytes == null ? sandboxSpaceReason(r.reason) : null
                const found = states?.find((b) => b.name === r.name)
                const gone = !!found && sandboxGone(found)
                return (
                  <li key={r.name} className={css.sdRow} data-even data-space-sandbox={r.name}>
                    <button type="button" className={css.sdRowButton} onClick={() => go({ kind: 'sandbox', machine: m.name, name: r.name })} title={r.name}>
                      <SandboxGlyph size={13} />
                      <span className={css.mono}>{shortSandbox(r.name)}</span>
                      {gone && r.bytes != null && r.bytes > 0 && <span className={css.spaceGone} data-space-gone>{t('spaceGone')}</span>}
                    </button>
                    <span className={css.sdSize} title={why ? tw(why) : undefined}>{why ? <span className={css.muted}>—</span> : r.reason === 'deadline' ? t('spaceAtLeast', { size: size(r.bytes) }) : size(r.bytes)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}
