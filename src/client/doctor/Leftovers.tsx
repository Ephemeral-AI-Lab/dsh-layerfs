/**
 * What interrupted operations left on disk, as `layerfs doctor` reports it
 * (layerfs-project#180 "Leftovers"): one row per leftover with its machine,
 * what it is, its path, size and age, the command that removes it as text to
 * copy, and a one-way "Show in Files" link to the machine's Files tab at its
 * path (owner decision D9: the Files tree itself carries no leftover marks).
 * Below the rows, what LayerFS only counts and keeps (image lock files,
 * unmount markers): a count per machine and no command.
 *
 * This page runs nothing: `layerfs doctor fix <id>` is the person's to run,
 * and LayerFS checks each kind's guard when it does. A leftover LayerFS only
 * reports (`fixable: false`) has no command. Where the pinned CLI cannot list
 * a machine's files, the link is replaced by the reason.
 */
import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { ago, bytes } from '../files/format.ts'
import type { Translate } from '../files/types.ts'
import { useMachinesContext } from '../machines/context.tsx'
import type { StorageT } from '../storage/locale.ts'
import type { DoctorFinding, LeftoverWalk } from '../storage/types.ts'
import { CopyLine, LinkButton } from '../ui/index.tsx'
import type { DoctorKey, DoctorT } from './locale.ts'
import { fixCommand, fixCondition, leftoverFindings, walksToShow } from './leftover-model.ts'
import css from './Health.module.css'

const KIND: Record<string, DoctorKey> = {
  'run-folder': 'leftoverRunFolder', 'empty-root': 'leftoverEmptyRoot', 'init-copy': 'leftoverInitCopy',
  'backup-staging': 'leftoverBackupStaging', 'image-tmp': 'leftoverImageTmp', 'image-part': 'leftoverImagePart',
}

/** LayerFS's text with its `backticked` spans set as code. */
function Inline({ text }: { text: string }): ReactNode {
  return text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i} className={css.code}>{part}</code> : part))
}

export function Leftovers({ findings, walks, at, now, t, ts }: {
  findings: readonly DoctorFinding[]
  walks: readonly LeftoverWalk[] | undefined
  /** When the report was read: ages count from then. */
  at: number
  now: number
  t: DoctorT
  ts: StorageT
}): ReactNode {
  const mc = useMachinesContext()
  const canShow = mc.useMachines((s) => (s.data?.available ? s.data.features?.inspect?.machineFiles === true : false))
  const rows = leftoverFindings(findings)
  const kept = walksToShow(walks)
  if (!rows.length && !kept.length) return null
  const place = (machine: string) => (machine === 'native' ? ts('groupHome') : machine)
  return (
    <section className={css.block} aria-label={t('leftoversTitle')} data-leftovers>
      <div className={css.blockHead}>
        <h2 className={css.blockTitle}>{t('leftoversTitle')}</h2>
        {rows.length ? <span className={css.blockCount}>{rows.length}</span> : null}
      </div>
      <p className={css.leftoversIntro}>{t('leftoversIntro')}</p>
      {rows.length ? (
        <ul className={css.findings}>
          {rows.map((f) => {
            const l = f.leftover
            const kind = Object.hasOwn(KIND, l.kind) ? t(KIND[l.kind]!) : l.kind
            const condition = fixCondition(f.fix, l)
            const waits = l.notBefore != null && l.notBefore > now
            return (
              <li key={l.id} className={css.leftover} data-leftover={l.id} data-leftover-kind={l.kind} data-leftover-machine={l.machine}>
                <span className={css.findingTop}>
                  <Tag tone="warning">{kind}</Tag>
                  <span className={css.entity}>{t('leftoverOn', { machine: place(l.machine) })}</span>
                </span>
                <code className={css.leftoverPath} data-leftover-path>{l.path}</code>
                <span className={css.leftoverMeta}>
                  <span data-leftover-size={l.bytes == null ? 'not-measured' : String(l.bytes)}>{l.bytes == null ? t('leftoverSizeNone') : t('leftoverSize', { size: bytes(l.bytes) })}</span>
                  {l.age != null ? <span data-leftover-age={l.age}> · {t('leftoverAge', { ago: ago(at - l.age * 1000, now, ts as Translate) })}</span> : null}
                </span>
                {l.fixable ? (
                  <div className={css.leftoverFix} data-leftover-fix>
                    <span className={css.fix}>{t('leftoverFixLabel')}</span>
                    <CopyLine text={fixCommand(l)} copyLabel={t('leftoverCopy', { command: fixCommand(l) })} copiedLabel={t('healthCopied')} />
                  </div>
                ) : <span className={css.fix} data-leftover-report-only>{t('leftoverReportOnly')}</span>}
                {condition ? <span className={css.fix} data-leftover-condition><Inline text={condition} /></span> : null}
                {waits ? <span className={css.fix} data-leftover-not-before>{t('leftoverNotBefore', { time: new Date(l.notBefore!).toLocaleString() })}</span> : null}
                {canShow
                  ? <LinkButton onClick={() => mc.go({ kind: 'machine', name: l.machine, tab: 'files', view: 'layerfs', path: l.path })} title={t('leftoverShowInFilesTitle', { machine: place(l.machine) })}>{t('leftoverShowInFiles')}</LinkButton>
                  : <span className={css.fix} data-leftover-files="unavailable">{t('leftoverNoFiles')}</span>}
              </li>
            )
          })}
        </ul>
      ) : null}
      {kept.length ? (
        <ul className={css.leftoverKept} aria-label={t('leftoverKeptTitle')}>
          {kept.map((w) => {
            const what = [
              w.imageLocks ? (w.imageLocks === 1 ? t('leftoverLocksOne') : t('leftoverLocks', { n: w.imageLocks })) : null,
              w.unmountMarkers ? (w.unmountMarkers === 1 ? t('leftoverMarkersOne') : t('leftoverMarkers', { n: w.unmountMarkers })) : null,
            ].filter(Boolean).join(', ')
            return (
              <li key={w.machine} data-leftover-walk={w.machine} data-image-locks={w.imageLocks} data-unmount-markers={w.unmountMarkers}>
                {what ? <span>{t('leftoverKeptLine', { machine: place(w.machine), what })}</span> : null}
                {!w.complete ? <span data-leftover-incomplete>{what ? ' ' : ''}{t('leftoverWalkIncomplete', { machine: place(w.machine) })}</span> : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
