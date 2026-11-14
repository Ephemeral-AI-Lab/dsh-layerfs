/**
 * The Presets dialog, opened from the LayerFS home: every preset this host
 * offers in a list on the left (quick starts first, then full demos), the
 * selected one's status, actions, machines and projects on the right. Each
 * list row says what the preset needs and how big it is, so the cost is clear
 * before Build. One home holds one preset's library at a time; building
 * another replaces it (the Build confirmation lists what goes).
 */
import { useState, type ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import type { DemoPreset } from '../../shared/presets.ts'
import { LoadError, Loading } from '../ui/index.tsx'
import { refusalLabels } from './labels.ts'
import type { PresetsKey, PresetsT } from './locale.ts'
import { Library, presetCommits, presetName, presetRunning, usePresets } from './PresetsSection.tsx'
import { count } from './Progress.tsx'
import css from './presets.module.css'

/** Quick starts need no virtual machine. */
const isQuick = (preset: DemoPreset) => !preset.requirements.includes('lima')

/** The list row's state, in words. */
function stateKey(preset: DemoPreset): PresetsKey {
  if (presetRunning(preset.job)) return 'stateBuilding'
  if (preset.contentReady) return 'stateBuilt'
  if (preset.built) return 'stateStale'
  return 'stateNotBuilt'
}

/** What a preset needs and how big it is, as short chips. */
function chips(t: PresetsT, preset: DemoPreset): string[] {
  return [
    ...(preset.requirements.includes('docker') ? [t('chipDocker')] : []),
    ...(preset.requirements.includes('lima') ? [t('chipLima')] : [t('chipNoVm')]),
    ...(preset.machines.length > 1 ? [t('chipMachines', { n: preset.machines.length })] : []),
    t('chipCommits', { n: count(presetCommits(preset)) }),
  ]
}

export function PresetsDialog({ api, t, open, onClose }: { api: LayerfsApi, t: PresetsT, open: boolean, onClose: () => void }): ReactNode {
  return (
    <Modal open={open} headless onClose={onClose} title={t('openTitle')} className={css.dialog}>
      {open ? <Body api={api} t={t} onClose={onClose} /> : null}
    </Modal>
  )
}

function Body({ api, t, onClose }: { api: LayerfsApi, t: PresetsT, onClose: () => void }): ReactNode {
  const live = usePresets(api)
  const [picked, setPicked] = useState<string>()
  const items = live.data?.items ?? []
  const groups: Array<{ key: PresetsKey, items: DemoPreset[] }> = [
    { key: 'groupQuick', items: items.filter(isQuick) },
    { key: 'groupFull', items: items.filter((p) => !isQuick(p)) },
  ]
  // Default to what the home holds now, else the first quick start.
  const selected = items.find((p) => p.id === picked) ?? items.find((p) => p.built) ?? groups.find((g) => g.items.length)?.items[0]

  return (
    <div className={css.dialogFrame}>
      <header className={css.dialogHead}>
        <div className={css.dialogHeadText}>
          <h2 className={css.dialogTitle}>{t('openTitle')}</h2>
          <p className={css.muted}>{t('dialogIntro')}</p>
        </div>
        <Button variant="ghost" size="sm" className={css.iconButton} icon={<IconCloseOutlineRegular size={16} />} aria-label={t('close')} title={t('close')} onClick={onClose} />
      </header>
      {live.error !== undefined && !live.data ? (
        <div className={css.dialogPad}><LoadError title={t('loadFailed')} error={live.error} labels={refusalLabels(t)} retryLabel={t('retry')} onRetry={live.reload} /></div>
      ) : !live.data ? (
        <div className={css.dialogPad}><Loading label={t('loading')} /></div>
      ) : (
        <div className={css.dialogBody}>
          <nav className={css.presetList} aria-label={t('listLabel')}>
            {groups.filter((g) => g.items.length).map((g) => (
              <section key={g.key} className={css.presetGroup} aria-label={t(g.key)}>
                <p className={css.presetGroupName}>{t(g.key)}</p>
                {g.items.map((p) => (
                  <button key={p.id} type="button" className={css.presetItem} aria-current={p.id === selected?.id ? 'true' : undefined} onClick={() => setPicked(p.id)}>
                    <span className={css.presetItemHead}>
                      <span className={css.presetItemName}>{presetName(t, p)}</span>
                      <span className={css.presetItemState}>{t(stateKey(p))}</span>
                    </span>
                    <span className={css.presetChips}>{chips(t, p).join(' · ')}</span>
                  </button>
                ))}
              </section>
            ))}
          </nav>
          <div className={css.presetDetail}>
            {selected ? <Library key={selected.id} api={api} t={t} data={live.data} preset={selected} onRefresh={live.reload} className={css.libraryBare} /> : null}
          </div>
        </div>
      )}
    </div>
  )
}
