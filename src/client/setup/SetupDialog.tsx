/**
 * Set up LayerFS (docs/specs/layerfs-setup.md §4.1): one modal, one
 * scrolling column — Runtime, LayerFS folder, Machines — each section's
 * state in words beside its title. It reads the host's setup check (`setup.status`), which already
 * created a missing folder; converting an older folder waits for Convert
 * here. Done needs a runtime, the folder current and no piece from another
 * build (an unknown passes); the SDK and the folder's mode are notes. The
 * modal opens by itself once per page load when something required is
 * missing (setup/index.tsx); Later is remembered per viewer.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconCloseOutlineRegular, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { MachineGlyph } from '../machines/icons.tsx'
import type { MachinesKey } from '../machines/locale.ts'
import type { AvailableView, MachineInfo, MachinesView, Words } from '../machines/model.ts'
import { nativeGlyphOs, nativeNameKey, osOfView, readinessOf, stepReasons } from '../machines/needs.ts'
import { requestSocketSetting } from '../machines/socket.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { openStorage } from '../projects/navigation.ts'
import { CopyLine } from '../ui/index.tsx'
import { useQuery } from '../ui/use-query.ts'
import { useHostEvents } from '../storage/hooks.ts'
import type { SetupModalT } from './locale.ts'
import { RuntimePicker } from './RuntimePicker.tsx'
import { lately, setupDialog, useSetupStatus, type Piece, type SetupSection, type SetupStatus } from './store.ts'
import dialog from '../projects/setup/dialog.module.css'
import css from './setup.module.css'

/** The machines namespace's `t`, for machine names and readiness reasons. */
export type MachinesT = (key: MachinesKey, params?: Record<string, string>) => string

export const short = (commit: string | null | undefined): string => (commit ? commit.slice(0, 8) : '—')
const messageOf = (e: unknown): string => String((e as { message?: string } | null)?.message ?? e)

/** Whether each section is ready (a check on the rail) by the setup check. */
export function readiness(s: SetupStatus | undefined, machines: AvailableView | null): Record<SetupSection, boolean> {
  const native = machines?.platforms.find((p) => p.platform === 'native')
  return {
    runtime: !!s && s.runtime.ok && !s.needs.includes('build'),
    folder: !!s && s.folder.state === 'current',
    machines: !!native && readinessOf(native, osOfView(machines!), machines!.layerfs).step === 'ready',
  }
}

/** The words of what still blocks Done, or null when nothing does. */
export function missingWords(s: SetupStatus | undefined, t: SetupModalT): string | null {
  if (!s) return null
  if (s.needs.includes('runtime')) return t('missingRuntime')
  if (s.needs.includes('build')) return t('missingBuild')
  if (s.needs.includes('folder')) return t('missingFolder')
  return null
}

export function SetupDialog({ api, t, tm, section }: { api: LayerfsApi, t: SetupModalT, tm: MachinesT, section: SetupSection }): ReactNode {
  const id = useId()
  const status = useSetupStatus(api, true)
  const s = status.data
  const usable = !!s && s.runtime.ok && s.folder.state === 'current'
  const [tick, setTick] = useState(0)
  // reread on what changes the machines (a runtime or folder change, machine events), not on every setup poll
  const machines = useQuery(() => (usable ? api.call<MachinesView>('GET', '/api/machines') : Promise.resolve(null)), [api, usable], { refresh: [tick, s?.runtime.cli, s?.folder.state], cache: usable ? 'GET /api/machines' : undefined })
  useHostEvents(api, ['machine-progress', 'runtime-changed'], () => setTick((n) => n + 1), { coalesceMs: 1000 })
  const view = machines.data && (machines.data as AvailableView).available ? machines.data as AvailableView : null
  const ready = readiness(s, view)
  const pane = useRef<HTMLDivElement>(null)
  const parts = useRef<Partial<Record<SetupSection, HTMLElement | null>>>({})
  // opened at a section: show it once the page has drawn
  const shown = useRef(false)
  useEffect(() => {
    if (shown.current || !s) return
    shown.current = true
    const root = pane.current, target = parts.current[section]
    if (section !== 'runtime' && root && target) root.scrollTo({ top: Math.max(0, target.offsetTop - 12) })
  }, [s])
  const tw = (w: Words) => tm(w.key as MachinesKey, w.values as Record<string, string> | undefined)
  const summaries: Record<SetupSection, string> = {
    runtime: !s ? '…' : !s.runtime.cli ? t('sumNoRuntime') : !s.runtime.ok ? t('sumRuntimeFailed') : [s.pieces.bundle, s.pieces.daemon].some((x) => x?.verdict === 'other') ? t('sumMixed') : t('sumRuntime', { version: s.runtime.version ?? '?', commit: short(s.runtime.commit) }),
    folder: !s ? '…' : folderSummary(s, t),
    machines: !usable ? t(s?.runtime.ok ? 'sumMachinesWaitFolder' : 'sumMachinesWait') : !view ? t('sumMachinesReading') : machinesSummary(view, tm, t),
  }
  const titles: Record<SetupSection, string> = { runtime: t('railRuntime'), folder: t('railFolder'), machines: t('railMachines') }
  const missing = missingWords(s, t)
  // Check again says "Checking…" for its own read, not for the background rereads
  const [manual, setManual] = useState(false)
  const wasLoading = useRef(false)
  useEffect(() => { if (wasLoading.current && !status.loading) setManual(false); wasLoading.current = status.loading }, [status.loading])
  const checking = manual && status.loading
  const close = () => setupDialog.close()
  const head = (k: SetupSection) => (
    <div className={css.sectionHead}>
      <h3 id={`${id}-${k}`} className={dialog.partTitle}>{titles[k]}</h3>
      <span className={css.sectionState} data-ready={ready[k] || undefined}>{summaries[k]}</span>
    </div>
  )
  return (
    <Modal open headless onClose={close} title={t('title')} className={clsx(dialog.dialog, css.modal)}>
      <div className={dialog.form} data-setup-modal="">
        <header className={dialog.head}>
          <div className={dialog.headRow}>
            <span className={dialog.headTile} aria-hidden="true"><LayerfsGlyph size={20} /></span>
            <span className={dialog.headText}>
              <h2 className={dialog.title}>{t('title')}</h2>
              <span className={dialog.sub}>{t('sub')}</span>
            </span>
            <Button variant="ghost" size="sm" className={dialog.close} icon={<IconCloseOutlineRegular size={16} />} aria-label={t('close')} title={t('close')} onClick={close} />
          </div>
        </header>
        <div ref={pane} className={css.scroll}>
          {status.error && !s ? <p className={dialog.error} role="alert">{t('readFailed', { message: messageOf(status.error) })}</p> : null}
          {!s && !status.error ? <p className={dialog.notice}>{t('checking')}</p> : null}
          {s ? <>
            <section ref={(el) => { parts.current.runtime = el }} className={css.section} data-section="runtime" aria-labelledby={`${id}-runtime`}>
              {head('runtime')}
              <RuntimeSection api={api} s={s} t={t} />
            </section>
            <section ref={(el) => { parts.current.folder = el }} className={css.section} data-section="folder" aria-labelledby={`${id}-folder`}>
              {head('folder')}
              <FolderSection api={api} s={s} t={t} />
            </section>
            <section ref={(el) => { parts.current.machines = el }} className={css.section} data-section="machines" aria-labelledby={`${id}-machines`}>
              {head('machines')}
              <MachinesSection api={api} usable={usable} view={view} error={machines.error} t={t} tm={tm} tw={tw} onChanged={() => setTick((n) => n + 1)} />
            </section>
          </> : null}
        </div>
        <footer className={dialog.foot}>
          <span className={dialog.footNote}>{s ? missing ?? t('allSet') : null}</span>
          <div className={dialog.footActions}>
            <Button variant="ghost" size="sm" disabled={checking} onClick={() => { setManual(true); status.check() }}>{checking ? t('checking') : t('checkAgain')}</Button>
            {missing ? <Button variant="outline" size="sm" onClick={() => setupDialog.later()}>{t('later')}</Button> : null}
            <Button variant="primary" size="sm" disabled={!s || !!missing} onClick={() => setupDialog.done()}>{t('done')}</Button>
          </div>
        </footer>
      </div>
    </Modal>
  )
}

function folderSummary(s: SetupStatus, t: SetupModalT): string {
  const f = s.folder
  if (f.state === 'current') { const did = lately(s); return did === 'converted' ? t('sumFolderConverted') : did === 'created' ? t('sumFolderCreated') : t('sumFolderReady') }
  if (f.state === 'needs_conversion') return t('sumFolderOld')
  if (f.state === 'unknown') return t('sumFolderUnknown')
  return t('sumFolderMissing')
}

function machinesSummary(view: AvailableView, tm: MachinesT, t: SetupModalT): string {
  const os = osOfView(view)
  const native = view.platforms.find((p) => p.platform === 'native')
  const name = tm(nativeNameKey(os))
  return native && readinessOf(native, os, view.layerfs).step === 'ready' ? t('sumNativeReady', { native: name }) : t('sumNativeBlocked', { native: name })
}

/** A verdict as words and a tone. */
function VerdictWord({ piece, t, sdk }: { piece: Piece | null, t: SetupModalT, sdk?: boolean }): ReactNode {
  const v = piece?.verdict ?? 'missing'
  const word = v === 'matches' ? t('vMatches') : v === 'other' ? t('vOther') : v === 'unknown' ? t('vUnknown') : t('vMissing')
  return <span className={css.verdict} data-verdict={sdk ? 'note' : v}>{word}</span>
}

const sourceKey = (source: SetupStatus['runtime']['source']) =>
  source === 'config' ? 'sourceConfig' as const : source === 'settings' ? 'sourceSettings' as const : source === 'env' ? 'sourceEnv' as const : source === 'home' ? 'sourceHome' as const : 'sourceNone' as const

function RuntimeSection({ api, s, t }: { api: LayerfsApi, s: SetupStatus, t: SetupModalT }): ReactNode {
  const [changing, setChanging] = useState<'pick' | 'other' | null>(!s.runtime.cli ? 'pick' : null)
  const r = s.runtime
  const p = s.pieces
  return (
    <div className={dialog.fields}>
      {r.cli ? (
        <div className={css.line}>
          <span className={css.lineText}>
            <span className={css.lineTitle}>{r.version ? t('runtimeLine', { version: r.version }) : short(r.commit)}{r.commit ? <span className={css.commit}>{short(r.commit)}</span> : null}</span>
            <span className={css.lineSub}>{t('runtimeFrom', { source: t(sourceKey(r.source)) })}</span>
          </span>
          {changing ? null : <span className={css.lineActions}>
            <Button variant="outline" size="sm" onClick={() => setChanging('pick')}>{t('change')}</Button>
          </span>}
        </div>
      ) : <p className={dialog.notice}>{t('runtimeNone')}</p>}
      {r.error && r.cli ? <p className={dialog.error} role="alert">{t('runtimeError', { code: r.error.code, message: r.error.message })}</p> : null}
      {r.ok ? (
        <dl className={css.pieces}>
          <PieceRow label={t('pieceCli')} path={p.cli?.path ?? r.cli} value={<span className={css.verdict} data-verdict="matches">{t('vCli')}</span>} />
          {p.daemon ? <PieceRow label={t('pieceDaemon')} path={p.daemon.path} value={<VerdictWord piece={p.daemon} t={t} />} note={p.daemon.verdict === 'missing' ? t('daemonMissingNote') : null} /> : null}
          <PieceRow label={t('pieceBundle')} path={p.bundle?.path ?? null} value={<VerdictWord piece={p.bundle} t={t} />} note={!p.bundle || p.bundle.verdict === 'missing' ? t('bundleMissingNote') : null} />
          <PieceRow label={t('pieceSdk')} path={r.sdk?.dir ?? null} value={<span className={css.verdict} data-verdict={r.sdk ? 'matches' : 'note'}>{r.sdk ? t('sdkPresent') : t('sdkMissing')}</span>} note={r.sdk ? null : t('sdkNote')} />
        </dl>
      ) : null}
      {[p.bundle, p.daemon].some((x) => x?.verdict === 'other') ? <p className={dialog.warn} role="status">{s.mixedAllowed ? t('mixedAllowedNote') : t('mixedNote')}</p> : null}
      {s.daemonRecordable ? <RecordDaemon api={api} t={t} /> : null}
      {changing ? <RuntimePicker api={api} t={t} other={changing === 'other'} onOther={() => setChanging('other')} onDone={() => setChanging(r.cli ? null : 'pick')} cancellable={!!r.cli} /> : null}
    </div>
  )
}

/** The native machine records another build's daemon: record this runtime's (never automatic: hosts sharing a home would flip it). */
function RecordDaemon({ api, t }: { api: LayerfsApi, t: SetupModalT }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const run = async () => { setBusy(true); setError(null); try { await api.op('setup.recordDaemon') } catch (e) { setError(e) } finally { setBusy(false) } }
  return (
    <div className={css.line}>
      <span className={css.lineSub}>{t('daemonRecordedOther')}</span>
      <span className={css.lineActions}><Button variant="outline" size="sm" disabled={busy} onClick={() => void run()}>{busy ? t('saving') : t('recordDaemon')}</Button></span>
      {error != null ? <p className={dialog.error} role="alert">{messageOf(error)}</p> : null}
    </div>
  )
}

function PieceRow({ label, path, value, note }: { label: string, path: string | null, value: ReactNode, note?: string | null }): ReactNode {
  return (
    <div className={css.piece}>
      <dt className={css.pieceLabel}>{label}</dt>
      <dd className={css.pieceValue}>
        {value}
        {path ? <span className={css.path} title={path}>{path}</span> : null}
        {note ? <span className={css.note}>{note}</span> : null}
      </dd>
    </div>
  )
}

function FolderSection({ api, s, t }: { api: LayerfsApi, s: SetupStatus, t: SetupModalT }): ReactNode {
  const f = s.folder
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const convert = async () => {
    setBusy(true); setError(null)
    try { await api.op('setup.convert') } catch (e) { setError(e) } finally { setBusy(false) }
  }
  const did = lately(s)
  // current: the section's head already says so; the line gives the folder's facts
  const words = f.state === 'current' ? (f.layout != null && f.mode ? t('folderFacts', { layout: f.layout, mode: f.mode }) : did === 'converted' ? t('folderConverted') : did === 'created' ? t('folderCreated') : t('folderReady'))
    : f.state === 'needs_conversion' ? t('folderOld')
      : f.state === 'unknown' ? t('folderUnknown')
        : s.runtime.ok ? t('sumFolderMissing') : t('folderMissingNoRuntime')
  return (
    <div className={dialog.fields}>
      <div className={css.line}>
        <span className={css.lineText}>
          <span className={clsx(css.lineTitle, css.mono)} title={f.path}>{f.path}</span>
          <span className={css.lineSub} data-state={f.state}>{words}</span>
        </span>
        {f.state === 'needs_conversion' && s.homeCalls
          ? <span className={css.lineActions}><Button variant="primary" size="sm" disabled={busy} onClick={() => void convert()}>{busy ? t('converting') : t('convert')}</Button></span>
          : null}
      </div>
      {f.state === 'needs_conversion' ? <p className={dialog.warn}>{s.homeCalls ? t('folderOldWarn') : t('folderOldCli')}</p> : null}
      {error != null ? <p className={dialog.error} role="alert">{t('convertBlocked', { message: messageOf(error) })}</p> : null}
      {f.modeOk === false ? (
        <div className={css.noteBlock}>
          <span className={css.note}>{t('modeNote', { mode: f.mode ?? '?' })}</span>
          <CopyLine text={`chmod 700 '${f.path}'`} copyLabel={t('copy')} copiedLabel={t('copied')} />
        </div>
      ) : null}
    </div>
  )
}

/** A built-in machine's state as words: running, stopped, never started (no worker yet). */
function stateKey(m: MachineInfo | undefined): 'stateRunning' | 'stateStopped' | 'stateNever' | 'stateReady' {
  if (!m) return 'stateNever'
  if (m.platform === 'native') return 'stateReady'
  if (m.state === 'running') return 'stateRunning'
  if (m.state === 'missing' || m.state === 'absent' || m.state === 'unknown' || m.state === 'none') return 'stateNever'
  return 'stateStopped'
}

function MachinesSection({ api, usable, view, error, t, tm, tw, onChanged }: {
  api: LayerfsApi, usable: boolean, view: AvailableView | null, error: unknown, t: SetupModalT, tm: MachinesT, tw: (w: Words) => string, onChanged: () => void
}): ReactNode {
  const [starting, setStarting] = useState(false)
  const [failed, setFailed] = useState<unknown>(null)
  if (!usable) return <p className={dialog.notice}>{t('machinesWait')}</p>
  if (!view) return error ? <p className={dialog.error} role="alert">{t('machinesFailed', { message: messageOf(error) })}</p> : <p className={dialog.notice}>{t('sumMachinesReading')}</p>
  const os = osOfView(view)
  const start = async () => {
    setStarting(true); setFailed(null)
    try { await api.call('POST', '/api/machines/docker/start') } catch (e) { setFailed(e) } finally { setStarting(false); onChanged() }
  }
  const leave = (to: string) => { setupDialog.close(); openStorage(api, to) }
  const card = (platform: 'native' | 'docker') => {
    const p = view.platforms.find((x) => x.platform === platform)
    const m = view.machines.find((x) => x.platform === platform)
    const r = p ? readinessOf(p, os, view.layerfs) : null
    const blocked = !r || r.step !== 'ready'
    const native = platform === 'native'
    const name = native ? tm(nativeNameKey(os)) : tm('kindDocker' as MachinesKey)
    const state = !p ? t('stateBlocked') : blocked ? t('stateBlocked') : t(stateKey(m))
    const socket = native ? null : (p as { socket?: { path?: string | null } } | undefined)?.socket?.path ?? null
    const facts = native
      ? [view.computer?.name, view.computer?.arch].filter(Boolean).join(' · ')
      : !p ? t('dockerNoMachine') : blocked ? stepReasons(r!, tw) : socket ? t('socketIn', { path: socket }) : null
    const canStart = !native && !!m && m.state !== 'running' && !!r && (r.step === 'ready' || r.step === 'start')
    return (
      <article key={platform} className={css.machineCard} data-platform={platform} data-blocked={blocked || undefined}>
        <div className={css.machineHead}>
          <span className={css.machineTile} aria-hidden="true"><MachineGlyph platform={platform} os={native ? nativeGlyphOs(os) : undefined} size={18} /></span>
          <span className={css.machineName}>{name}</span>
          <span className={css.machineState} data-blocked={blocked || undefined}>{state}</span>
        </div>
        <p className={css.machineRole}>{native ? t('nativeRole') : t('dockerRole')}</p>
        {facts ? <p className={css.machineFacts} data-blocked={blocked || undefined} title={socket ?? undefined}>{facts}</p> : null}
        {!native && p && m ? (
          <div className={css.machineActions}>
            {canStart ? <Button variant="outline" size="sm" disabled={starting} icon={starting ? <StateDot state="ongoing" size={10} /> : undefined} onClick={() => void start()}>{starting ? t('starting') : t('startDocker')}</Button> : null}
            <Button variant="ghost" size="sm" onClick={() => { requestSocketSetting(); leave(`machine:${m.name}`) }}>{t('socket')}</Button>
          </div>
        ) : null}
      </article>
    )
  }
  return (
    <div className={dialog.fields}>
      <div className={css.machineGrid}>{card('native')}{card('docker')}</div>
      {failed != null ? <p className={dialog.error} role="alert">{messageOf(failed)}</p> : null}
      <div className={css.vmRow}>
        <span className={css.lineSub}>{t('vmsLine')}</span>
        <Button variant="ghost" size="sm" onClick={() => leave('machines:new')}>{t('addMachine')}</Button>
      </div>
    </div>
  )
}
