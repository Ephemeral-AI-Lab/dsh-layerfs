/**
 * The LayerFS runtime this page reads through (`runtime.status`): one summary
 * row (version, CLI, state) that unfolds into its facts, and Change… to pin
 * another CLI and daemon (`runtime.save`; absolute paths, discovered before
 * the pin moves).
 */
import { useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, Fact, Facts, Field, Refusal, StateChip } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import type { RuntimeStatus } from './model.ts'
import css from './machines.module.css'

const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)

export function RuntimeSection(): ReactNode {
  const { t, useRuntime, useConnected, refusal } = useMachinesContext()
  const read = useRuntime((s) => s)
  const connected = useConnected((s) => s)
  const [open, setOpen] = useState(false)
  const [changing, setChanging] = useState(false)
  const r = read.data
  const version = r?.version ? t('runtimeVersion', { version: r.version }) : t('runtimeTitle')
  const tone = !r ? (read.status === 'error' ? 'danger' : 'neutral') : r.ok ? 'success' : 'danger'
  const word = !r ? (read.status === 'error' ? t('runtimeUnreadable') : t('runtimeReading')) : r.ok ? t('runtimeReady') : t('runtimeFailed')
  return (
    <Card className={css.runtime}>
      <div className={css.runtimeRow}>
        <button type="button" className={css.runtimeSummary} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className={css.runtimeText}>
            <span className={css.runtimeTitle}>{version}{r?.commit ? <span className={css.runtimeCommit}>{r.commit.slice(0, 8)}</span> : null}</span>
            <span className={css.runtimeSub} title={r?.cli ?? undefined}>{r?.cli ?? (r ? t('runtimeNoCli') : t('runtimeLabel'))}</span>
          </span>
          <StateChip tone={tone} label={word} live={read.status === 'loading'} />
          {!connected && <StateChip tone="warning" label={t('eventsOffline')} />}
          <IconChevronDownOutlineRegular size={14} className={css.runtimeChevron} aria-hidden="true" />
        </button>
        <Button variant="outline" size="sm" disabled={!r} onClick={() => setChanging(true)}>{t('runtimeChange')}</Button>
      </div>
      {open && (
        <div className={css.runtimeBody}>
          {read.status === 'error' && !r && <Refusal error={read.error} labels={refusal} />}
          {r && (
            <Facts label={t('runtimeLabel')}>
              <Fact label={t('runtimeCli')} mono>{r.cli}</Fact>
              <Fact label={t('runtimeDaemon')} mono>{r.daemon}</Fact>
              <Fact label={t('runtimeHome')} mono>{r.home}</Fact>
              <Fact label={t('runtimeVersionLabel')} mono>{r.version}</Fact>
              <Fact label={t('runtimeCommit')} mono>{r.commit}</Fact>
              {r.source && <Fact label={t('runtimeSource')}>{t(r.source === 'settings' ? 'sourceSettings' : r.source === 'env' ? 'sourceEnv' : r.source === 'config' ? 'sourceConfig' : 'sourceNone')}</Fact>}
              {r.error && <Fact label={t('runtimeError')} tone="danger">{`${r.error.code}: ${r.error.message}`}</Fact>}
            </Facts>
          )}
        </div>
      )}
      {changing && r && <RuntimeDialog current={r} onClose={() => setChanging(false)} />}
    </Card>
  )
}

/** Pin another CLI (and daemon); LayerFS discovers the CLI first and refuses one it cannot use. */
function RuntimeDialog({ current, onClose }: { current: RuntimeStatus, onClose: () => void }): ReactNode {
  const { t, saveRuntime, refusal } = useMachinesContext()
  const [cli, setCli] = useState(current.cli ?? '')
  const [daemon, setDaemon] = useState(current.daemon ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const cliBad = cli.trim() !== '' && !isAbsolute(cli.trim())
  const daemonBad = daemon.trim() !== '' && !isAbsolute(daemon.trim())
  const save = async (pin: { cli: string | null, daemon: string | null }) => {
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
          <Button variant="primary" disabled={busy || !cli.trim() || cliBad || daemonBad} onClick={() => void save({ cli: cli.trim(), daemon: daemon.trim() || null })}>{busy ? t('saving') : t('save')}</Button>
        </>
      )}>
      <form className={css.form} onSubmit={(e) => { e.preventDefault(); if (cli.trim() && !cliBad && !daemonBad) void save({ cli: cli.trim(), daemon: daemon.trim() || null }) }}>
        <Field label={t('runtimeCli')} error={cliBad ? t('errAbsolute') : null}>
          <Input value={cli} onChange={(e) => setCli(e.target.value)} placeholder="/path/to/layerfs" spellCheck={false} disabled={busy} autoFocus />
        </Field>
        <Field label={t('runtimeDaemon')} error={daemonBad ? t('errAbsolute') : null} hint={t('runtimeDaemonHint')}>
          <Input value={daemon} onChange={(e) => setDaemon(e.target.value)} placeholder="/path/to/layerfs-daemon" spellCheck={false} disabled={busy} />
        </Field>
        {error != null && <Refusal error={error} labels={refusal} className={css.errorText} />}
      </form>
    </Modal>
  )
}
