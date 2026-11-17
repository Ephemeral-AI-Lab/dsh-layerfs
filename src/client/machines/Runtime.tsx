/**
 * The LayerFS runtime the plugin reads through (`runtime.status`). The
 * Settings page shows it whole: version, state, every fact, and Change… to pin
 * another CLI and daemon (`runtime.save`; absolute paths, discovered before the
 * pin moves). Storage's home overview reveals the same card.
 */
import { useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SetupModalT } from '../setup/locale.ts'
import { RuntimePicker } from '../setup/RuntimePicker.tsx'
import { Card, Fact, Facts, Refusal, StateChip } from '../ui/index.tsx'
import { useMachinesContext, type MachinesContext } from './context.tsx'
import type { RuntimeStatus } from './model.ts'
import css from './machines.module.css'


const sourceKey = (source: string) =>
  source === 'settings' ? 'sourceSettings' as const : source === 'env' ? 'sourceEnv' as const : source === 'config' ? 'sourceConfig' as const : source === 'home' ? 'sourceHome' as const
    : source === 'inherited' ? 'sourceInherited' as const : source === 'default' ? 'sourceDefault' as const : 'sourceNone' as const

/** The whole runtime: its version and state, Change…, and every fact. */
export function RuntimeCard({ ts }: { ts: SetupModalT }): ReactNode {
  const { t, useRuntime, useConnected, refusal } = useMachinesContext()
  const read = useRuntime((s) => s)
  const connected = useConnected((s) => s)
  const [changing, setChanging] = useState(false)
  const r = read.data
  const version = r?.version ? t('runtimeVersion', { version: r.version }) : t('runtimeTitle')
  const tone = !r ? (read.status === 'error' ? 'danger' : 'neutral') : r.ok ? 'success' : 'danger'
  const word = !r ? (read.status === 'error' ? t('runtimeUnreadable') : t('runtimeReading')) : r.ok ? t('runtimeReady') : t('runtimeFailed')
  return (
    <Card className={css.runtime}>
      <div className={css.runtimeRow}>
        <span className={css.runtimeHead}>
          <span className={css.runtimeText}>
            <span className={css.runtimeTitle}>{version}{r?.commit ? <span className={css.runtimeCommit}>{r.commit.slice(0, 8)}</span> : null}</span>
          </span>
          <StateChip tone={tone} label={word} live={read.status === 'loading'} />
          {!connected && <StateChip tone="warning" label={t('eventsOffline')} />}
        </span>
        <Button variant="outline" size="sm" disabled={!r} onClick={() => setChanging(true)}>{t('runtimeChange')}</Button>
      </div>
      <div className={css.runtimeBody}>
        {read.status === 'error' && !r && <Refusal error={read.error} labels={refusal} />}
        {r && <RuntimeFacts r={r} t={t} />}
      </div>
      {changing && r && <RuntimeDialog current={r} ts={ts} onClose={() => setChanging(false)} />}
    </Card>
  )
}

function RuntimeFacts({ r, t }: { r: RuntimeStatus, t: MachinesContext['t'] }): ReactNode {
  return (
    <Facts label={t('runtimeLabel')}>
      <Fact label={t('runtimeCli')} mono title={r.cli ?? undefined}>{r.cli}</Fact>
      <Fact label={t('runtimeDaemon')} mono title={r.daemon ?? undefined}>{r.daemon}</Fact>
      <Fact label={t('runtimeBundle')} mono title={r.bundle ?? undefined}>{r.bundle ? `${r.bundle}${r.bundleInfo?.hash ? ` (${r.bundleInfo.hash.slice(0, 12)})` : ''}` : t('runtimeBundleDefault')}</Fact>
      {r.ok && <Fact label={t('runtimeSdk')} mono={!!r.sdk} title={r.sdk?.dir ?? (r.sdkDir ? t('runtimeSdkMissingHint', { path: r.sdkDir }) : undefined)}>{r.sdk ? `${r.sdk.dir} (${r.sdk.commit.slice(0, 10)})` : t('runtimeSdkMissing')}</Fact>}
      {r.cacheHome && <Fact label={t('runtimeImages')} mono title={r.cacheHomeSource ? `${r.cacheHome} — ${t(sourceKey(r.cacheHomeSource))}` : r.cacheHome}>{t('runtimeImagesValue', { path: r.cacheHome, count: String(r.preparedImages ?? 0) })}</Fact>}
      <Fact label={t('runtimeHome')} mono title={r.home}>{r.home}</Fact>
      {/* The card's head already names the version; the row only shows when the head cannot. */}
      {!r.version && <Fact label={t('runtimeVersionLabel')} mono>{r.version}</Fact>}
      <Fact label={t('runtimeCommit')} mono>{r.commit}</Fact>
      {r.source && <Fact label={t('runtimeSource')}>{t(sourceKey(r.source))}</Fact>}
      {r.error && <Fact label={t('runtimeError')} tone="danger">{`${r.error.code}: ${r.error.message}`}</Fact>}
    </Facts>
  )
}

/** Change…: the shared runtime picker (setup/RuntimePicker.tsx) in a modal; Other build… holds the path fields. */
function RuntimeDialog({ current, ts, onClose }: { current: RuntimeStatus, ts: SetupModalT, onClose: () => void }): ReactNode {
  const { t, api } = useMachinesContext()
  const [other, setOther] = useState(false)
  return (
    <Modal open onClose={onClose} title={ts('pickerTitle')} closeLabel={t('close')} className={css.dialog}>
      <RuntimePicker api={api} t={ts} other={other} onOther={() => setOther(true)} onDone={onClose} cancellable
        current={{ cli: current.cli ?? null, daemon: current.daemon ?? null, bundle: current.bundle ?? null, cacheHome: current.cacheHome ?? null, cacheHomeSource: current.cacheHomeSource, source: current.source }} />
    </Modal>
  )
}
