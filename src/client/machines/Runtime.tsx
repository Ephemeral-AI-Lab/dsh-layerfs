/**
 * The LayerFS runtime the plugin reads through (`runtime.status`). The
 * Settings page shows it whole: version, state, every fact, and Change… to pin
 * another CLI and daemon (`runtime.save`; absolute paths, discovered before the
 * pin moves). Storage's home overview reveals the same card.
 */
import { useState, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, Fact, Facts, Field, Refusal, StateChip } from '../ui/index.tsx'
import { useMachinesContext, type MachinesContext } from './context.tsx'
import type { RuntimeStatus } from './model.ts'
import css from './machines.module.css'

const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)

const sourceKey = (source: string) =>
  source === 'settings' ? 'sourceSettings' as const : source === 'env' ? 'sourceEnv' as const : source === 'config' ? 'sourceConfig' as const : source === 'home' ? 'sourceHome' as const
    : source === 'inherited' ? 'sourceInherited' as const : source === 'default' ? 'sourceDefault' as const : 'sourceNone' as const

/** The whole runtime: its version and state, Change…, and every fact. */
export function RuntimeCard(): ReactNode {
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
      {changing && r && <RuntimeDialog current={r} onClose={() => setChanging(false)} />}
    </Card>
  )
}

function RuntimeFacts({ r, t }: { r: RuntimeStatus, t: MachinesContext['t'] }): ReactNode {
  return (
    <Facts label={t('runtimeLabel')}>
      <Fact label={t('runtimeCli')} mono title={r.cli ?? undefined}>{r.cli}</Fact>
      <Fact label={t('runtimeDaemon')} mono title={r.daemon ?? undefined}>{r.daemon}</Fact>
      <Fact label={t('runtimeBundle')} mono title={r.bundle ?? undefined}>{r.bundle ? `${r.bundle}${r.bundleInfo?.hash ? ` (${r.bundleInfo.hash.slice(0, 12)})` : ''}` : t('runtimeBundleDefault')}</Fact>
      {r.cacheHome && <Fact label={t('runtimeImages')} mono title={r.cacheHomeSource ? `${r.cacheHome} — ${t(sourceKey(r.cacheHomeSource))}` : r.cacheHome}>{t('runtimeImagesValue', { path: r.cacheHome, count: String(r.preparedImages ?? 0) })}</Fact>}
      <Fact label={t('runtimeHome')} mono title={r.home}>{r.home}</Fact>
      <Fact label={t('runtimeVersionLabel')} mono>{r.version}</Fact>
      <Fact label={t('runtimeCommit')} mono>{r.commit}</Fact>
      {r.source && <Fact label={t('runtimeSource')}>{t(sourceKey(r.source))}</Fact>}
      {r.error && <Fact label={t('runtimeError')} tone="danger">{`${r.error.code}: ${r.error.message}`}</Fact>}
    </Facts>
  )
}

/** Pin another CLI (and daemon); LayerFS discovers the CLI first and refuses one it cannot use. */
function RuntimeDialog({ current, onClose }: { current: RuntimeStatus, onClose: () => void }): ReactNode {
  const { t, saveRuntime, refusal } = useMachinesContext()
  const [cli, setCli] = useState(current.cli ?? '')
  const [daemon, setDaemon] = useState(current.daemon ?? '')
  const [bundle, setBundle] = useState(current.bundle ?? '')
  // only a cache chosen on this page is editable here; an inherited one shows as the placeholder
  const [cacheHome, setCacheHome] = useState(current.cacheHomeSource === 'settings' ? current.cacheHome ?? '' : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const cliBad = cli.trim() !== '' && !isAbsolute(cli.trim())
  const daemonBad = daemon.trim() !== '' && !isAbsolute(daemon.trim())
  const bundleBad = bundle.trim() !== '' && !isAbsolute(bundle.trim())
  const cacheBad = cacheHome.trim() !== '' && !isAbsolute(cacheHome.trim())
  const bad = cliBad || daemonBad || bundleBad || cacheBad
  const pin = () => ({ cli: cli.trim(), daemon: daemon.trim() || null, bundle: bundle.trim() || null, cacheHome: cacheHome.trim() || null })
  const save = async (pin: { cli: string | null, daemon: string | null, bundle?: string | null, cacheHome?: string | null }) => {
    setBusy(true)
    setError(null)
    try { await saveRuntime(pin); onClose() } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return (
    <Modal open onClose={() => { if (!busy) onClose() }} title={t('runtimeChangeTitle')} description={t('runtimeChangeBody')} closeLabel={t('close')} className={css.dialog}
      footer={(
        <>
          <Button variant="ghost" disabled={busy || current.source !== 'settings'} onClick={() => void save({ cli: null, daemon: null })} title={t('runtimeResetTitle')}>{t('runtimeReset')}</Button>
          <span className={css.footerSpacer} />
          <Button variant="outline" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy || !cli.trim() || bad} onClick={() => void save(pin())}>{busy ? t('saving') : t('save')}</Button>
        </>
      )}>
      <form className={css.form} onSubmit={(e) => { e.preventDefault(); if (cli.trim() && !bad) void save(pin()) }}>
        <Field label={t('runtimeCli')} error={cliBad ? t('errAbsolute') : null}>
          <Input value={cli} onChange={(e) => setCli(e.target.value)} placeholder="/path/to/layerfs" spellCheck={false} disabled={busy} autoFocus />
        </Field>
        <Field label={t('runtimeDaemon')} error={daemonBad ? t('errAbsolute') : null} hint={t('runtimeDaemonHint')}>
          <Input value={daemon} onChange={(e) => setDaemon(e.target.value)} placeholder="/path/to/layerfs-daemon" spellCheck={false} disabled={busy} />
        </Field>
        <Field label={t('runtimeBundle')} error={bundleBad ? t('errAbsolute') : null} hint={t('runtimeBundleHint')}>
          <Input value={bundle} onChange={(e) => setBundle(e.target.value)} placeholder="/path/to/bundle/2.0.0/linux-aarch64" spellCheck={false} disabled={busy} />
        </Field>
        <Field label={t('runtimeImages')} error={cacheBad ? t('errAbsolute') : null} hint={t('runtimeImagesHint')}>
          <Input value={cacheHome} onChange={(e) => setCacheHome(e.target.value)} placeholder={current.cacheHomeSource !== 'settings' && current.cacheHome ? current.cacheHome : '/path/to/cache'} spellCheck={false} disabled={busy} />
        </Field>
        {error != null && <Refusal error={error} labels={refusal} className={css.errorText} />}
      </form>
    </Modal>
  )
}
