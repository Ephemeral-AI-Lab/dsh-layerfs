/**
 * The setup's cards outside the modal (docs/specs/layerfs-setup.md §4.1,
 * §4.3): Center's body while nothing is set up (instead of an error box),
 * the "Finish setting up LayerFS" card while something required is missing
 * after Later, and Settings' summary of the setup check.
 */
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { CopyLine } from '../ui/index.tsx'
import type { SetupModalT } from './locale.ts'
import { missingWords, short } from './SetupDialog.tsx'
import { setupDialog, type SetupStatus } from './store.ts'
import css from './setup.module.css'

/** Whether Center has nothing to show without setup: no runtime, or a folder LayerFS can't use yet. */
export const unset = (s: SetupStatus | undefined): boolean => !!s && (s.needs.includes('runtime') || s.needs.includes('folder'))

/** Center's card: nothing set up (`first`), or what is left after Later. */
export function SetupCard({ s, t, first }: { s: SetupStatus, t: SetupModalT, first: boolean }): ReactNode {
  return (
    <div className={css.card} role="status" data-setup-card={first ? 'setup' : 'finish'}>
      <span className={css.cardTile} aria-hidden="true"><LayerfsGlyph size={22} /></span>
      <span className={css.lineText}>
        <h2 className={css.cardTitle}>{first ? t('cardSetupTitle') : t('cardFinishTitle')}</h2>
        <span className={css.lineSub}>{first ? t('cardSetupBody') : t('cardFinishBody', { what: missingWords(s, t) ?? '' })}</span>
      </span>
      <span className={css.lineActions}>
        <Button variant="primary" size="sm" onClick={() => setupDialog.open(s.needs.includes('folder') && s.runtime.ok ? 'folder' : 'runtime')}>{t('openSetup')}</Button>
      </span>
    </div>
  )
}

/** Settings' summary: the folder and pieces in one line each, LayerFS's notes, the terminal line, Check setup…. */
export function SetupSummary({ s, t }: { s: SetupStatus, t: SetupModalT }): ReactNode {
  const r = s.runtime
  const terminal = r.cli ? [`LAYERFS_HOME='${s.folder.path}'`, ...(r.bundle ? [`LAYERFS_BUNDLE='${r.bundle}'`] : []), `'${r.cli}'`].join(' ') : null
  const verdict = (v: string | undefined) => (v === 'matches' ? t('vMatches') : v === 'other' ? t('vOther') : v === 'unknown' ? t('vUnknown') : t('vMissing'))
  const pieces = [
    s.pieces.daemon ? `${t('pieceDaemon')}: ${verdict(s.pieces.daemon.verdict)}` : null,
    `${t('pieceBundle')}: ${verdict(s.pieces.bundle?.verdict)}`,
    `${t('pieceSdk')}: ${r.sdk ? t('sdkPresent') : t('sdkMissing')}`,
  ].filter(Boolean).join(' · ')
  return (
    <div className={css.summary} data-setup-summary="">
      <div className={css.line}>
        <span className={css.lineText}>
          <span className={css.lineTitle}>{r.ok ? t('sumRuntime', { version: r.version ?? '?', commit: short(r.commit) }) : t('sumNoRuntime')}</span>
          {r.ok ? <span className={css.lineSub}>{pieces}</span> : null}
          <span className={css.lineSub}>{t('railFolder')}: {s.folder.path} · {folderWord(s, t)}</span>
        </span>
        <span className={css.lineActions}><Button variant="outline" size="sm" onClick={() => setupDialog.open()}>{t('checkSetup')}</Button></span>
      </div>
      {s.warnings.length ? (
        <ul className={css.warnings} aria-label={t('warnings')}>
          {s.warnings.map((w) => <li key={w.code} className={css.warning} data-tone={w.code === 'HomeMode' ? 'note' : 'warning'}>{w.message}</li>)}
        </ul>
      ) : null}
      {terminal ? (
        <div className={css.noteBlock}>
          <span className={css.note}>{t('terminal')}</span>
          <CopyLine text={terminal} copyLabel={t('copy')} copiedLabel={t('copied')} />
        </div>
      ) : null}
    </div>
  )
}

function folderWord(s: SetupStatus, t: SetupModalT): string {
  const f = s.folder
  return f.state === 'current' ? t('sumFolderReady') : f.state === 'needs_conversion' ? t('sumFolderOld') : f.state === 'unknown' ? t('sumFolderUnknown') : t('sumFolderMissing')
}
