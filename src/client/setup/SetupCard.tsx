/**
 * The setup's cards outside the modal (docs/specs/layerfs-setup.md §4.1,
 * §4.3): Center's body while nothing is set up (instead of an error box),
 * the "Finish setting up LayerFS" card while something required is missing
 * after Later.
 */
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import type { SetupModalT } from './locale.ts'
import { missingWords } from './SetupDialog.tsx'
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
