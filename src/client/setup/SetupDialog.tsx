/**
 * Set up LayerFS (docs/specs/layerfs-setup.md §4.1): one modal, two sections,
 * each a short list of rows (summary.ts says what each row reads):
 *
 *   LayerFS   the folder (Convert when an older LayerFS made it) and the
 *             build (one row; Change… picks a runtime; Details shows each
 *             piece's path and verdict)
 *   Machines  what this computer can run, one row per platform: Ready or
 *             Available, else why not with Install… / Set up… (a how-to and
 *             Check) or Check (an installed tool that does not answer)
 *
 * It reads the host's setup check (`setup.status`), which already created a
 * missing folder; converting an older folder waits for Convert here. Done
 * needs a runtime, the folder current and no piece from another build (an
 * unknown passes); the SDK and the folder's mode are notes. The modal opens
 * by itself once per page load when something required is missing
 * (setup/index.tsx); Later is remembered per viewer.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconFolderCloseRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { MachineGlyph } from '../machines/icons.tsx'
import type { MachinesKey } from '../machines/locale.ts'
import { kindKey, type AvailableView, type MachinesView, type Words } from '../machines/model.ts'
import { nativeGlyphOs, nativeNameKey, osOfView, stepReasons, type HostOs } from '../machines/needs.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { CopyLine } from '../ui/index.tsx'
import { useQuery } from '../ui/use-query.ts'
import { useHostEvents } from '../storage/hooks.ts'
import type { SetupModalT } from './locale.ts'
import { RuntimePicker } from './RuntimePicker.tsx'
import { buildWords, canRun, platformRows, short, type PlatformRow } from './summary.ts'
import { verdictWords } from './verdict.ts'
import { lately, setupDialog, useSetupStatus, type Piece, type SetupSection, type SetupStatus } from './store.ts'
import dialog from '../projects/setup/dialog.module.css'
import css from './setup.module.css'

export { short } from './summary.ts'

/** The machines namespace's `t`, for machine names and readiness reasons. */
export type MachinesT = (key: MachinesKey, params?: Record<string, string>) => string

const messageOf = (e: unknown): string => String((e as { message?: string } | null)?.message ?? e)
const URL_LINE = /^https?:\/\//

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
  const pane = useRef<HTMLDivElement>(null)
  const machinesPart = useRef<HTMLElement | null>(null)
  // opened at Machines: show it once the page has drawn (the LayerFS section is first anyway)
  const shown = useRef(false)
  useEffect(() => {
    if (shown.current || !s) return
    shown.current = true
    const root = pane.current, target = machinesPart.current
    if (section === 'machines' && root && target) root.scrollTo({ top: Math.max(0, target.offsetTop - 12) })
  }, [s])
  const tw = (w: Words) => tm(w.key as MachinesKey, w.values as Record<string, string> | undefined)
  const os: HostOs = view ? osOfView(view) : 'macos'
  const rows = view ? platformRows(view.platforms, os, { bundleDir: s?.pieces.bundle?.path ?? null }) : []
  const count = canRun(rows)
  const missing = missingWords(s, t)
  // the head counts the rows that warn (the folder, the build), so it never says Ready beside an Incomplete build
  const toFix = !s ? 0 : (s.folder.state === 'current' ? 0 : 1) + (buildWords(s, (k) => t(k)).state === 'ready' ? 0 : 1)
  const layerfsState = !s ? '…' : toFix === 0 ? t('stateReady') : t('toFix', { n: toFix })
  const machinesState = !usable ? t(s?.runtime.ok ? 'sumMachinesWaitFolder' : 'sumMachinesWait') : !view ? t('sumMachinesReading') : t('canRunCount', { n: count.n, total: count.total })
  // Check again says "Checking…" for its own read, not for the background rereads
  const [manual, setManual] = useState(false)
  const wasLoading = useRef(false)
  useEffect(() => { if (wasLoading.current && !status.loading) setManual(false); wasLoading.current = status.loading }, [status.loading])
  const checking = manual && status.loading
  const close = () => setupDialog.close()
  // Check (a machine row) and Check again: a fresh probe of the platforms, then the view rereads
  const recheck = async () => { try { if (usable) await api.call('GET', '/api/machines?fresh=1') } finally { setTick((n) => n + 1) } }
  return (
    <Modal open headless onClose={close} title={t('title')} className={clsx(dialog.dialog, css.modal)}>
      <div className={dialog.form} data-setup-modal="">
        <header className={dialog.head}>
          <div className={dialog.headRow}>
            <span className={dialog.headTile} aria-hidden="true"><LayerfsGlyph size={20} /></span>
            <span className={dialog.headText}>
              <h2 className={dialog.title}>{t('title')}</h2>
            </span>
            <Button variant="ghost" size="sm" className={dialog.close} icon={<IconCloseOutlineRegular size={16} />} aria-label={t('close')} title={t('close')} onClick={close} />
          </div>
        </header>
        <div ref={pane} className={css.scroll}>
          {status.error && !s ? <p className={dialog.error} role="alert">{t('readFailed', { message: messageOf(status.error) })}</p> : null}
          {!s && !status.error ? <p className={dialog.notice}>{t('checking')}</p> : null}
          {s ? <>
            <section className={css.section} data-section="layerfs" aria-labelledby={`${id}-layerfs`}>
              <div className={css.sectionHead}>
                <h3 id={`${id}-layerfs`} className={dialog.partTitle}>{t('sectionLayerfs')}</h3>
                <span className={css.sectionState} data-ready={toFix === 0 || undefined}>{layerfsState}</span>
              </div>
              <LayerfsSection api={api} s={s} t={t} />
            </section>
            <section ref={machinesPart} className={css.section} data-section="machines" aria-labelledby={`${id}-machines`}>
              <div className={css.sectionHead}>
                <h3 id={`${id}-machines`} className={dialog.partTitle}>{t('railMachines')}</h3>
                <span className={css.sectionState} data-ready={(usable && !!view && rows.some((r) => r.state === 'ready')) || undefined}>{machinesState}</span>
              </div>
              <MachinesSection usable={usable} view={view} rows={rows} os={os} error={machines.error} t={t} tm={tm} tw={tw} recheck={recheck} />
            </section>
          </> : null}
        </div>
        <footer className={dialog.foot}>
          <span className={dialog.footNote}>{missing}</span>
          <div className={dialog.footActions}>
            <Button variant="ghost" size="sm" disabled={checking} onClick={() => { setManual(true); status.check(); void recheck() }}>{checking ? t('checking') : t('checkAgain')}</Button>
            {missing ? <Button variant="outline" size="sm" onClick={() => setupDialog.later()}>{t('later')}</Button> : null}
            <Button variant="primary" size="sm" disabled={!s || !!missing} onClick={() => setupDialog.done()}>{t('done')}</Button>
          </div>
        </footer>
      </div>
    </Modal>
  )
}

/** One row of a section: a tile, a title and a line, a state word, and at most one action. */
function Row({ tile, title, line, lineMono, lineWarn, state, warn, action, data }: {
  tile: ReactNode, title: ReactNode, line?: ReactNode, lineMono?: boolean, lineWarn?: boolean, state: string, warn: boolean, action?: ReactNode, data?: string
}): ReactNode {
  return (
    <div className={css.row} data-row={data}>
      <span className={css.rowTile} aria-hidden="true">{tile}</span>
      <span className={css.rowText}>
        <span className={css.rowTitle}>{title}</span>
        {line ? <span className={clsx(css.rowLine, lineMono && css.mono)} data-warn={lineWarn || undefined} title={typeof line === 'string' ? line : undefined}>{line}</span> : null}
      </span>
      <span className={css.rowState} data-warn={warn || undefined}>{state}</span>
      {action ? <span className={css.rowAction}>{action}</span> : null}
    </div>
  )
}

function LayerfsSection({ api, s, t }: { api: LayerfsApi, s: SetupStatus, t: SetupModalT }): ReactNode {
  const r = s.runtime
  const [changing, setChanging] = useState<'pick' | 'other' | null>(!r.cli ? 'pick' : null)
  const [details, setDetails] = useState(false)
  const b = buildWords(s, (k) => t(k))
  const line = b.line ? t(b.line, b.values) : null
  const title = r.cli
    ? <>{r.version ? t('runtimeLine', { version: r.version }) : t('runtimeUnnamed')}{r.commit ? <span className={css.commit}>{short(r.commit)}</span> : null}</>
    : t('runtimeTitle')
  return (
    <div className={css.rows}>
      <FolderRow s={s} t={t} />
      <Row data="build" tile={<LayerfsGlyph size={16} />} title={title} line={line} lineWarn={b.state !== 'ready'} state={t(b.word)} warn={b.state !== 'ready'}
        action={changing ? null : <Button variant="outline" size="sm" onClick={() => setChanging('pick')}>{r.cli ? t('change') : t('choose')}</Button>} />
      {s.daemonRecordable ? <RecordDaemon api={api} t={t} /> : null}
      {b.state === 'mixed' && s.mixedAllowed ? <p className={css.rowNote}>{t('mixedAllowedNote')}</p> : null}
      {changing ? <RuntimePicker api={api} t={t} other={changing === 'other'} onOther={() => setChanging('other')} onDone={() => setChanging(null)} cancellable={!!r.cli} /> : null}
      {r.cli ? (
        <div className={css.details}>
          <button type="button" className={css.detailsToggle} aria-expanded={details} onClick={() => setDetails(!details)}>
            {details ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
            {t('details')}
          </button>
          {details ? <Pieces s={s} t={t} /> : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The LayerFS folder. An older LayerFS's folder (`outdated`) is not converted
 * by LayerFS 2.0: its word, LayerFS's sentence as the tip, and its fix line
 * (move it aside, then `layerfs home init`) to copy and run by hand; the page
 * never moves a folder.
 */
function FolderRow({ s, t }: { s: SetupStatus, t: SetupModalT }): ReactNode {
  const f = s.folder
  const did = lately(s)
  const word = f.state === 'current' ? (did === 'created' ? t('sumFolderCreated') : t('stateReady'))
    : f.state === 'outdated' ? t('sumFolderOld')
      : f.state === 'unknown' ? t('sumFolderUnknown')
        : t('sumFolderMissing')
  return (
    <>
      <Row data="folder" tile={<IconFolderCloseRegular size={16} />} title={t('folderTitle')} line={f.path} lineMono state={word} warn={f.state !== 'current'} />
      {f.state === 'outdated' ? (
        <div className={css.noteBlock}>
          <span className={css.note} data-warn="" title={f.message ?? undefined}>{t('folderOldNote')}</span>
          {f.fix ? <CopyLine text={f.fix} copyLabel={t('copy')} copiedLabel={t('copied')} /> : null}
        </div>
      ) : null}
      {f.state === 'unknown' ? <p className={css.rowNote} data-warn="">{t('folderUnknown')}</p> : null}
      {f.state === 'missing' && !s.runtime.ok ? <p className={css.rowNote}>{t('folderMissingNoRuntime')}</p> : null}
      {f.modeOk === false ? (
        <div className={css.noteBlock}>
          <span className={css.note}>{t('modeNote', { mode: f.mode ?? '?' })}</span>
          <CopyLine text={`chmod 700 '${f.path}'`} copyLabel={t('copy')} copiedLabel={t('copied')} />
        </div>
      ) : null}
    </>
  )
}

/** Details: one table, a piece per row (its word and path), then the terminal line; LayerFS's notes when it has any. */
function Pieces({ s, t }: { s: SetupStatus, t: SetupModalT }): ReactNode {
  const r = s.runtime, p = s.pieces
  const terminal = r.cli ? [`LAYERFS_HOME='${s.folder.path}'`, ...(r.bundle ? [`LAYERFS_BUNDLE='${r.bundle}'`] : []), `'${r.cli}'`].join(' ') : null
  return (
    <div className={css.detailsBody}>
      {r.error ? <p className={dialog.error} role="alert">{t('runtimeError', { code: r.error.code, message: r.error.message })}</p> : null}
      <dl className={css.pieces}>
        {r.ok ? <>
          <PieceRow label={t('pieceCli')} path={p.cli?.path ?? r.cli} value={<span className={css.verdict} data-verdict="matches">{t('vCli')}</span>} />
          {p.daemon ? <PieceRow label={t('pieceDaemon')} path={p.daemon.path} value={<VerdictWord piece={p.daemon} cli={r.commit} t={t} />} /> : null}
          <PieceRow label={t('pieceBundle')} path={p.bundle?.path ?? null} value={<VerdictWord piece={p.bundle} cli={r.commit} t={t} />} />
          <PieceRow label={t('pieceSdk')} path={r.sdk?.dir ?? null} value={<span className={css.verdict} data-verdict={r.sdk ? 'matches' : 'note'}>{r.sdk ? t('sdkPresent') : t('sdkMissing')}</span>} />
        </> : null}
        {terminal ? <PieceRow label={t('terminal')} path={null} value={<CopyLine text={terminal} copyLabel={t('copy')} copiedLabel={t('copied')} />} /> : null}
      </dl>
      {s.warnings.length ? (
        <ul className={css.warnings} aria-label={t('warnings')}>
          {s.warnings.map((w) => <li key={w.code} className={css.warning} data-tone={w.code === 'HomeMode' ? 'note' : 'warning'}>{w.message}</li>)}
        </ul>
      ) : null}
    </div>
  )
}

/** A verdict as words and a tone (verdict.ts says what an unknown one records). */
function VerdictWord({ piece, cli, t }: { piece: Piece | null, cli: string | null, t: SetupModalT }): ReactNode {
  const w = verdictWords(piece, cli)
  return <span className={css.verdict} data-verdict={w.tone}>{t(w.key)}</span>
}

function PieceRow({ label, path, value }: { label: string, path: string | null, value: ReactNode }): ReactNode {
  return (
    <div className={css.piece}>
      <dt className={css.pieceLabel}>{label}</dt>
      <dd className={css.pieceValue}>
        {value}
        {path ? <span className={css.path} title={path}>{path}</span> : null}
      </dd>
    </div>
  )
}

/** The native machine records another build's daemon: record this runtime's (never automatic: hosts sharing a home would flip it). */
function RecordDaemon({ api, t }: { api: LayerfsApi, t: SetupModalT }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const run = async () => { setBusy(true); setError(null); try { await api.op('setup.recordDaemon') } catch (e) { setError(e) } finally { setBusy(false) } }
  return (
    <div className={css.rowFollow}>
      <span className={css.rowFollowText}>{t('daemonRecordShort')}</span>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void run()}>{busy ? t('saving') : t('recordDaemon')}</Button>
      {error != null ? <p className={dialog.error} role="alert">{messageOf(error)}</p> : null}
    </div>
  )
}

const STATE_KEY = {
  ready: 'stateReady', available: 'stateAvailable', notInstalled: 'stateNotInstalled', notRunning: 'stateNotRunning', needsSetup: 'stateNeedsSetup', needsBundle: 'stateNeedsBundle',
} as const

function MachinesSection({ usable, view, rows, os, error, t, tm, tw, recheck }: {
  usable: boolean, view: AvailableView | null, rows: PlatformRow[], os: HostOs, error: unknown, t: SetupModalT, tm: MachinesT, tw: (w: Words) => string, recheck: () => Promise<void>
}): ReactNode {
  const [open, setOpen] = useState<string | null>(null)
  if (!usable) return <p className={dialog.notice}>{t('machinesWait')}</p>
  if (!view) return error ? <p className={dialog.error} role="alert">{t('machinesFailed', { message: messageOf(error) })}</p> : <p className={dialog.notice}>{t('sumMachinesReading')}</p>
  if (rows.length === 0) return <p className={dialog.notice}>{t('machinesNone')}</p>
  return (
    <div className={css.rows}>
      {rows.map((row) => <PlatformLine key={row.platform} row={row} os={os} open={open === row.platform} onOpen={(on) => setOpen(on ? row.platform : null)} t={t} tm={tm} tw={tw} recheck={recheck} />)}
    </div>
  )
}

function PlatformLine({ row, os, open, onOpen, t, tm, tw, recheck }: {
  row: PlatformRow, os: HostOs, open: boolean, onOpen: (open: boolean) => void, t: SetupModalT, tm: MachinesT, tw: (w: Words) => string, recheck: () => Promise<void>
}): ReactNode {
  const [checking, setChecking] = useState(false)
  const check = () => { setChecking(true); void recheck().finally(() => setChecking(false)) }
  const native = row.platform === 'native'
  const key = kindKey(row.platform)
  const name = native ? tm(nativeNameKey(os)) : key ? tm(key) : row.platform
  const blocked = row.state !== 'ready' && row.state !== 'available'
  // the state word says it (Not installed, Not running, Needs the Linux bundle); only a host fact to set up needs its reason
  const line = row.state === 'needsSetup' ? stepReasons(row.readiness, tw) : null
  const checkButton = <Button variant="outline" size="sm" disabled={checking} onClick={check}>{checking ? t('checking') : t('check')}</Button>
  const action = row.action === 'check' ? checkButton
    : row.action === 'install' || row.action === 'setup'
      ? <Button variant="outline" size="sm" aria-expanded={open} onClick={() => onOpen(!open)}>{t(row.action === 'install' ? 'install' : 'setUp')}</Button>
      : null
  return (
    <>
      <Row data={row.platform} tile={<MachineGlyph platform={row.platform} os={native ? nativeGlyphOs(os) : undefined} size={16} />} title={name}
        line={line} lineWarn={blocked} state={t(STATE_KEY[row.state])} warn={blocked} action={action} />
      {open && (row.action === 'install' || row.action === 'setup') ? (
        <div className={css.howto}>
          {row.readiness.fixes.filter((f) => f.step === row.readiness.step).map((f) => (
            <div key={f.need} className={css.howtoStep}>
              <span>{f.how ? tw(f.how) : tw(f.why)}</span>
              {f.commands.map((c) => URL_LINE.test(c)
                ? <a key={c} href={c} target="_blank" rel="noreferrer" className={css.howtoLink}>{c}</a>
                : <CopyLine key={c} text={c} copyLabel={t('copy')} copiedLabel={t('copied')} />)}
            </div>
          ))}
          <span className={css.howtoFoot}>{checkButton}</span>
        </div>
      ) : null}
    </>
  )
}
