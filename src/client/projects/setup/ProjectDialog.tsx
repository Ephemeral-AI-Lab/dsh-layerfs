/**
 * The project dialog (docs/specs/layerfs-workspaces.md §2-§4): one modal that
 * creates or imports a project (a name and one Save to list of Stores, the
 * last-used chosen by default), configures where one runs, and picks a project to start
 * a session in. Both kinds run on one machine: a SQLite Store's file is placed
 * there (push / pull / move); a PostgreSQL Store is on no machine, so its
 * machine is only where its sessions run.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconCheckOutlineRegular, IconChevronLeftOutlineRegular, IconCloseOutlineRegular, IconFolderOpenOutlineRegular, IconInfoOutlineRegular, IconPlusOutlineRegular, IconSearchOutlineRegular, IconSettingsOutlineRegular, Input, Modal, relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import { StatusDot } from '../../ui/StatusDot.tsx'
import type { LayerfsApi } from '../../api.ts'
import { useQuery } from '../../files/use-query.ts'
import { MachineGlyph, StoreKindGlyph } from '../../machines/icons.tsx'
import { LayerfsGlyph } from '../../overview/glyph.tsx'
import { messageOf, NAME, type ProjectInitJob, type ProjectRow } from '../../picker/NewProjectForm.tsx'
import { slugify } from '../../picker/location.ts'
import { useHostEvents } from '../../storage/hooks.ts'
import { hasPgUrlLogin, isLinuxLocalhostUrl, PgLocalhostNotice, replaceLocalhostWithIpv4 } from '../../storage/pg-fields.tsx'
import { Signal } from '../../storage/Signal.tsx'
import type { StorageView, StoreRow } from '../../storage/types.ts'
import { refusalOf, usePressGuard } from '../../ui/index.tsx'
import { projectDialog, type DialogRequest, type ProjectRef } from '../dialog.ts'
import type { ListT } from '../list-locale.ts'
import { openStorage } from '../navigation.ts'
import { useProjectData, useRecent, type ProjectItem } from '../ProjectList.tsx'
import { sidebarStatus } from '../readiness.ts'
import { sidebarHidden } from '../recent.ts'
import { formatSessionFailure, pgStoreFailure } from '../session-failure.ts'
import { setupStateWord, type SetupT } from './locale.ts'
import type { MachinePlatformInfo } from '../../machines/model.ts'
import { createSteps, defaultMachine, machinesFor, needsStart, pgLoginProblem, pickable, resolveNewStoreName, stoppedOf, tileBlocks, lastUsedStore, defaultStoreChoice, type StoreChoice, type CreatePlan, type PgLogin, type PgLoginProblem, type Step, type StoreKind, isRunning, type Machine, type TileBlock } from './model.ts'
import { pgDefaultMachine, pgPlaceable } from '../../storage/model.ts'
import { StartFirst, type LocationWords } from './MachineTiles.tsx'
import { capWith, ChoiceList, ChoiceTile, ListFoot, MachineGrid, machineOrder, machineTileParts, TILE_CAP, TileActions, TileGrid, type ListGroup } from './Tiles.tsx'
import { bytes } from '../../files/format.ts'
import { placeStore, runStep, startMachine } from './run.ts'
import css from './dialog.module.css'
import { isHostName } from '../../../shared/host-machine.ts'

const PG_URL = /^postgres(?:ql)?:\/\//i
const enc = encodeURIComponent

/**
 * A Store a new project can use: ready, or a SQLite Store LayerFS reports `blocked` because its machine is stopped
 * or busy, which part 2 starts first (needsStart / StartFirst). A PostgreSQL Store must be ready.
 */
const storeUsable = (s: StoreRow): boolean => s.state === 'ready' || (s.kind === 'sqlite' && s.state === 'blocked')

/** `/api/storage`, refreshed on storage and machine events. */
export function useStorage(api: LayerfsApi) {
  const read = useQuery(() => api.call<StorageView>('GET', '/api/storage', undefined, { share: true }), [api], { cache: 'GET /api/storage' })
  useHostEvents(api, ['storage', 'storage-job', 'machine-progress', 'connection', 'layerfs-availability'], read.reload)
  return read
}

/**
 * `GET /api/platforms`: whether each platform can run here now, so a machine
 * whose platform is not ready (Docker not answering) shows blocked. Refused
 * or absent (an older host): nothing is blocked, as before.
 */
export function usePlatforms(api: LayerfsApi) {
  const read = useQuery(() => api.call<{ host: string, platforms: MachinePlatformInfo[] }>('GET', '/api/platforms').then((v) => v.platforms, () => undefined), [api], { cache: 'GET /api/platforms' })
  useHostEvents(api, ['machine-progress', 'connection', 'layerfs-availability'], read.reload, { coalesceMs: 1000 })
  return read.data
}

/** Render one dialog request (set as the dialog renderer by the projects area). */
export function ProjectDialog({ api, t, tl, request }: { api: LayerfsApi, t: SetupT, tl: ListT, request: DialogRequest }): ReactNode {
  const [busy, setBusy] = useState(false)
  const close = () => { if (!busy) projectDialog.close() }
  const back = request.mode !== 'pick' ? request.back : undefined
  const body = request.mode === 'configure'
    ? <Configure api={api} t={t} project={request.project} back={back} onBusy={setBusy} />
    : request.mode === 'pick'
      ? <Pick api={api} t={t} tl={tl} />
      : <Create api={api} t={t} startFromFolder={request.mode === 'import'} back={back} onBusy={setBusy} />
  const title = request.mode === 'configure' ? request.project.name ?? request.project.key.split('/')[1] ?? request.project.key
    : request.mode === 'pick' ? t('pickTitle') : request.mode === 'import' ? t('importTitle') : t('newTitle')
  return <Modal open headless onClose={close} title={title} className={clsx(css.dialog, request.mode !== 'pick' && css.narrow)}>
    {body}
  </Modal>
}

/** The dialog's head: Back (when opened from the picker), the LayerFS mark (or Back to the form, in a list view), the title, a line under it, and Close. */
function Head({ title, sub, t, back, onBack, subTitle }: { title: string, sub: ReactNode, t: SetupT, back?: DialogRequest | undefined, onBack?: (() => void) | undefined, subTitle?: string | undefined }): ReactNode {
  return <header className={css.head}>
    {back && !onBack
      ? <button type="button" className={css.back} onClick={() => projectDialog.open(back)}>
        <IconChevronLeftOutlineRegular size={14} /><span>{t('backToProjects')}</span>
      </button>
      : null}
    <div className={css.headRow}>
      {onBack
        ? <Button type="button" variant="ghost" size="sm" className={css.headBack} icon={<IconChevronLeftOutlineRegular size={16} />} aria-label={t('back')} title={t('back')} onClick={onBack} />
        : <span className={css.headTile} aria-hidden="true"><LayerfsGlyph size={18} /></span>}
      <span className={css.headText}>
        <h2 className={css.title}>{title}</h2>
        <span className={css.sub} title={subTitle}>{sub}</span>
      </span>
      <Button variant="ghost" size="sm" className={css.close} icon={<IconCloseOutlineRegular size={16} />} aria-label={t('close')} title={t('close')}
        onClick={() => projectDialog.close()} />
    </div>
  </header>
}

/** A quiet line under a section: an icon and the words (`warn`: something to act on first). */
function SectionNote({ children, tone }: { children: ReactNode, tone?: 'warn' | undefined }): ReactNode {
  return <p className={css.sectionNote} data-tone={tone}><IconInfoOutlineRegular size={13} /><span>{children}</span></p>
}

/** "2 h ago" in the dialog's words. */
function agoWords(at: number, t: SetupT): string {
  const r = relativeTime(at < 1e12 ? at * 1000 : at, Date.now())
  switch (r.unit) {
    case 'minutes': return t('agoMinutes', { n: r.n })
    case 'hours': return t('agoHours', { n: r.n })
    case 'days': return t('agoDays', { n: r.n })
    case 'months': return t('agoMonths', { n: r.n })
    case 'years': return t('agoYears', { n: r.n })
    default: return t('agoNow')
  }
}

function Loading({ read, t }: { read: { error: unknown, reload: () => void }, t: SetupT }): ReactNode {
  return read.error
    ? <div className={css.notice} role="alert">{t('loadFailed', { message: messageOf(read.error) })} <Button variant="ghost" size="sm" onClick={read.reload}>{t('retry')}</Button></div>
    : <div className={css.notice}>{t('loading')}</div>
}

/** A labelled control: every field in the dialog shares this label, hint and error. */
function Field({ label, hint, error, children, after, id }: { label: string, hint?: string | null | undefined, error?: string | null | undefined, children: ReactNode, after?: ReactNode, id?: string }): ReactNode {
  const message = error ? <span className={css.error} role="alert">{error}</span> : hint ? <span className={css.hint}>{hint}</span> : null
  // buttons beside the control (`after`) stay outside the <label>, so they are not part of the control's name: `id` names the control
  if (after) return <div className={css.field} data-invalid={error ? '' : undefined}>
    <label className={css.label} htmlFor={id}>{label}</label>
    <span className={css.inline}>{children}{after}</span>
    {message}
  </div>
  return <div className={css.field} data-invalid={error ? '' : undefined}>
    <label className={css.field}><span className={css.label}>{label}</span>{children}</label>
    {message}
  </div>
}

/** A group with the same label style as a field. */
function Group({ label, hint, children }: { label: string, hint?: string | undefined, children: ReactNode }): ReactNode {
  return <section className={css.field}>
    <h3 className={css.label}>{label}</h3>
    {children}
    {hint ? <p className={css.hint}>{hint}</p> : null}
  </section>
}

// ---------- pieces ----------

/** The tiles' words; `os` names the host machine (This Mac, unisolated; This computer, sandboxed; This PC). */
const wordsOf = (t: SetupT, os?: string): LocationWords => ({ thisMac: t(os === 'linux' ? 'thisLinux' : os === 'windows' ? 'thisPc' : 'thisMac'), hostOs: os === 'linux' ? 'linux' : os === 'windows' || os === 'other' ? 'pc' : 'mac', running: t('running'), stopped: t('stopped'), default: t('default'), here: t('here'), blocked: t('machineBlocked'), engineDown: t('engineDown'), state: (s) => setupStateWord(s, t) })

/** + New machine: Home's New machine page (the dialog closes). */
const newMachine = (api: LayerfsApi) => () => { projectDialog.close(); openStorage(api, 'machines:new') }

type StepState = { step: Step, state: 'pending' | 'running' | 'done' | 'failed' }

/** A path with the user's home folder shown as `~` (`/Users/me/code/shop` -> `~/code/shop`). */
export const shortPath = (path: string): string => path.replace(/\/+$/, '').replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')

/** StartFirst's words in this dialog's locale. */
const startWordsOf = (t: SetupT) => ({
  stopped: (machine: string) => t('stoppedFirst', { machine }),
  start: (machine: string) => t('startNamed', { machine }),
  refused: (machine: string) => t('startRefused', { machine }),
})

function stepLabel(step: Step, plan: CreatePlan, t: SetupT): string {
  const store = plan.store?.name ?? plan.newStore?.name ?? ''
  const id = step.id
  if (id === 'check') return t('step_check', { source: shortPath(plan.source ?? '') })
  if (id === 'store') return t('step_store', { store })
  if (id === 'connect') return t('step_connect', { store })
  if (id === 'init') return plan.source ? t('step_import', { source: shortPath(plan.source), name: plan.name }) : t('step_init', { name: plan.name })
  const machine = step.machine ?? ''
  if (id === 'open') return step.machine ? t('step_open_on', { machine }) : t('step_open')
  if (id.startsWith('attach:')) return t('step_attach', { store, machine })
  return t('step_place', { store, machine })
}

/** The running Init's phase and count: `hash · 8,412 / 12,930`. */
function initDetail(job: ProjectInitJob | null): string | null {
  const p = job?.progress
  if (!p?.phase) return null
  const n = (v: number | null) => (v === null ? null : v.toLocaleString())
  return p.total ? `${p.phase} · ${n(p.done ?? 0)} / ${n(p.total)}` : p.done !== null ? `${p.phase} · ${n(p.done)}` : p.phase
}

/** A stopped Create: the part of the form that holds what to change (the rail's three parts). */
const partOfStep = (step: Step): Part => (step.id === 'check' || step.id === 'init' ? 0 : step.id === 'store' || step.id === 'connect' ? 1 : 2)

/** Where a Create stopped: which step, and LayerFS's refusal (or the transport failure) as it came. */
interface Failure { step: Step, error: unknown }

/**
 * A stopped Create as a status (UI rule: dot and word, LayerFS's own words as
 * the tip, one action): Refused (LayerFS answered) or No answer,
 * the step, and Edit for the part that holds what to change.
 */
function Stopped({ failure, plan, t, part, onEdit }: { failure: Failure, plan: CreatePlan, t: SetupT, part: string, onEdit: () => void }): ReactNode {
  const r = refusalOf(failure.error)
  const word = r.transport === 'transport-unknown' || r.transport === 'unavailable' || r.code === 'no-host' ? t('noAnswer') : t('refused')
  const step = stepLabel(failure.step, plan, t)
  return <div className={css.stopped} role="alert" data-refusal={r.code}>
    <Signal state="error" title={word} label={`${word}: ${r.message}`} detail={<>{r.message}{r.fix ? <><br /><code>{r.fix}</code></> : null}</>} />
    <span className={css.stoppedWord}>· {step}</span>
    <Button type="button" variant="outline" size="sm" onClick={onEdit}>{t('editPart', { part })}</Button>
  </div>
}

function Progress({ steps, plan, t, failure, initJob, partTitle, onEdit }: {
  steps: StepState[], plan: CreatePlan, t: SetupT, failure: Failure | null, initJob: ProjectInitJob | null, partTitle: (part: Part) => string, onEdit: (part: Part) => void
}): ReactNode {
  return <div className={css.progress} aria-live="polite">
    <h3 className={css.label}>{failure ? t('createStopped') : t('creating')}</h3>
    <ol className={css.steps}>
      {steps.map(({ step, state }) => <li key={step.id} className={css.step} data-state={state}>
        <span className={css.stepMark} aria-hidden="true">{state === 'running' ? <StatusDot state="ongoing" size={10} /> : state === 'done' ? <IconCheckOutlineRegular size={11} /> : state === 'failed' ? <IconCloseOutlineRegular size={11} /> : null}</span>
        <span>{stepLabel(step, plan, t)}</span>
        {step.id === 'init' && state === 'running' && initDetail(initJob) ? <span className={css.stepDetail}>{initDetail(initJob)}</span> : null}
      </li>)}
    </ol>
    {failure ? <Stopped failure={failure} plan={plan} t={t} part={partTitle(partOfStep(failure.step))} onEdit={() => onEdit(partOfStep(failure.step))} /> : null}
  </div>
}

// ---------- create ----------

/** Where a stopped Create sends Edit: the name (0), the Store (1) or the machine (2). */
type Part = 0 | 1 | 2

/** What a new PostgreSQL connection still needs: its URL, else its login's problem. */
function pgMissing(problem: PgLoginProblem | 'url' | null, t: SetupT): string {
  switch (problem) {
    case 'url': return t('needUrl')
    case 'user': return t('needUser')
    case 'password': return t('needPassword')
    default: return t('needUrl')
  }
}
/** What the project starts from: nothing, or a copy of a folder on this computer. */
type StartFrom = 'empty' | 'folder'
/** The host machine in a summary line: This Mac, This PC or This computer, by the host's OS. */
const hostWordKey = (os?: string): 'hostMac' | 'hostPc' | 'hostLinux' => (os === 'windows' ? 'hostPc' : os === 'macos' || os === undefined ? 'hostMac' : 'hostLinux')

/**
 * Create (docs/specs/layerfs-workspaces.md §3): a name (From folder… turns it
 * into an import) and one Save to list: the existing Stores, the last-used
 * first and chosen by default, then New SQLite Store and Connect PostgreSQL….
 * Picking a row sets the Store and its kind; the chosen row opens in place to
 * ask only what it needs (a new Store's name and login, the machine) and to
 * show what needs the person (a stopped machine's Start, a Store that moves).
 * Create runs the steps and opens a session. `startFromFolder` opens it on a
 * folder (Import a folder).
 */
function Create({ api, t, startFromFolder, back, onBusy }: { api: LayerfsApi, t: SetupT, startFromFolder: boolean, back?: DialogRequest | undefined, onBusy: (busy: boolean) => void }): ReactNode {
  const id = useId()
  const view = useStorage(api)
  const recent = useRecent(api)
  const scratch = useQuery(() => api.op<{ scratchKey?: string | null }>('projects.catalog').catch(() => ({ scratchKey: null })), [api])
  const pane = useRef<HTMLDivElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const details = useRef<HTMLDivElement>(null)
  const storeSection = useRef<HTMLElement>(null)
  const machineSection = useRef<HTMLElement>(null)
  const [name, setName] = useState('')
  // the name follows the folder until it is typed in
  const [nameTyped, setNameTyped] = useState(false)
  const [from, setFrom] = useState<StartFrom>(startFromFolder ? 'folder' : 'empty')
  const importing = from === 'folder'
  const [source, setSource] = useState('')
  const [initJob, setInitJob] = useState<ProjectInitJob | null>(null)
  const [pickerMissing, setPickerMissing] = useState(false)
  // null: the default (model.ts defaultStoreChoice), which follows the Stores and recent projects as they load
  const [choice, setChoice] = useState<StoreChoice | null>(null)
  // All N Stores / All N machines open in place of the form
  const [sub, setSub] = useState<'stores' | 'machines' | null>(null)
  const [attempted, setAttempted] = useState(false)
  const [storeName, setStoreName] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [pgUser, setPgUser] = useState('')
  const [pgPassword, setPgPassword] = useState('')
  const [sqliteMachine, setSqliteMachine] = useState<string | null>(null)
  const [pgChoice, setPgChoice] = useState<string | null>(null)
  const [steps, setSteps] = useState<StepState[] | null>(null)
  const [shown, setShown] = useState<CreatePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const scratchStore = scratch.data?.scratchKey?.split('/')[0]
  const data = view.data
  const platforms = usePlatforms(api)
  const stores = (data?.stores ?? []).filter((s) => s.name !== scratchStore)
  const last = lastUsedStore(recent.data?.projects ?? [], stores)
  const auto = defaultStoreChoice(last, storeUsable)
  const picked = choice ?? auto.choice
  const existing = picked.kind === 'existing' ? stores.find((s) => s.name === picked.store) ?? null : null
  const kind: StoreKind = existing ? (existing.kind === 'postgresql' ? 'postgresql' : 'sqlite') : picked.kind === 'pg' ? 'postgresql' : 'sqlite'
  const creatingStore = !existing
  const machines = machinesFor(data, kind)
  // a machine whose platform is not ready here shows blocked; the default is the host machine when docker cannot run now
  const blocks = useMemo(() => tileBlocks(data?.machines ?? [], platforms, data?.computer?.os), [data, platforms])
  // PostgreSQL (V23-11): only machines that run now, are not broken or blocked here and run PostgreSQL Sandboxes are offered; never a stopped one
  const offered = kind === 'postgresql' ? machines.filter((m) => pgPlaceable(m) && !blocks.has(m.name)) : machines
  const fallback = defaultMachine(offered, blocks)
  const slug = slugify(name)
  const chosenSqlite = sqliteMachine ?? (existing?.machine ?? fallback)
  // PostgreSQL: the first session's own machine (spec v23: nothing Store-wide)
  const pgPicked = pgChoice && offered.some((m) => m.name === pgChoice) ? pgChoice : null
  // the project's last attached machine, else the only attached one, else none: the person picks (never a guessed default)
  const chosenPg = pgPicked ?? (existing ? pgDefaultMachine(existing, (data?.machines ?? []).filter((m) => !blocks.has(m.name))) : null)
  const chosen = kind === 'sqlite' ? [chosenSqlite] : chosenPg ? [chosenPg] : []
  // a pick not attached yet is attached by Create (createSteps); the dialog says so
  const willAttach = kind === 'postgresql' && chosenPg && !(existing?.attached ?? []).some((a) => a.machine === chosenPg) ? chosenPg : null
  const running = steps !== null && !error && !failure
  useEffect(() => { onBusy(running) }, [running])
  const words = wordsOf(t, data?.computer?.os)
  const machineWord = (m: string) => (isHostName(m) ? t(hostWordKey(data?.computer?.os)) : m)

  const folderName = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? ''
  const pickSource = (path: string) => { setSource(path); if (!nameTyped) setName(folderName(path)) }
  // a picker answer counts only if the path was not typed and Start from not changed since it opened
  const edits = useRef(0)
  const typeSource = (path: string) => { edits.current++; pickSource(path) }
  const browse = async () => {
    const at = edits.current
    try { const path = await api.pickDirectory(); if (path && edits.current === at) pickSource(path) }
    catch (e) { if ((e as { code?: string })?.code === 'no-picker') setPickerMissing(true); else setError(messageOf(e)) }
  }
  useEffect(() => { if (startFromFolder) void browse() }, [])
  const chooseFrom = (next: StartFrom) => {
    edits.current++
    setFrom(next)
    setAttempted(false)
    if (next === 'folder' && !source.trim() && !pickerMissing) void browse()
    if (next === 'empty' && !nameTyped) setName('')
  }

  const storeRes = resolveNewStoreName(slug, storeName, data)
  const autoStoreName = storeRes.autoName
  const chosenStoreName = storeRes.chosenName
  const storeConflictNotice = creatingStore && storeRes.conflictNotice
  const storeNameTaken = creatingStore && !!chosenStoreName && !!data?.stores.some((store) => store.name === chosenStoreName)
  // a typed or conflicting Store name is checked; a name that follows the project quietly is the project's own check
  const storeNameError = creatingStore && storeRes.showField && chosenStoreName
    ? (!NAME.test(chosenStoreName) ? t('storeNameInvalid') : storeNameTaken ? t('storeTaken', { store: chosenStoreName }) : null)
    : null
  // the Store's first 20 project names (StoreRow.projects): LayerFS still refuses a name taken past them
  const nameTaken = !!existing && !!slug && existing.projects.includes(slug)
  const nameError = name.trim() && !NAME.test(slug) ? t('nameInvalid')
    : nameTaken ? t('nameTakenInStore', { store: existing!.name, name: slug })
      : attempted && !slug && (!importing || source.trim()) ? t('needName') : null
  const folderError = importing && source.trim() && !source.trim().startsWith('/') ? t('folderInvalid')
    : attempted && importing && !source.trim() ? t('needFolder') : null
  const loginInUrl = kind === 'postgresql' && creatingStore && hasPgUrlLogin(url)
  const linuxLocalhost = kind === 'postgresql' && creatingStore && !loginInUrl && isLinuxLocalhostUrl(url, data?.computer?.os)
  const urlError = kind === 'postgresql' && creatingStore && (url.trim() || attempted)
    ? (!url.trim() ? t('needUrl') : loginInUrl ? t('urlLoginInUrl') : !PG_URL.test(url.trim()) ? t('urlInvalid') : null)
    : null
  const login: PgLogin = { user: pgUser, password: pgPassword }
  const loginProblem = kind === 'postgresql' && creatingStore ? pgLoginProblem(login) : null
  // the machines Create needs that are not running: each is started by its own Start below, never by Create
  const stopped = needsStart({ kind, store: existing, machines: chosen }, data)
  const startWords = startWordsOf(t)
  const ok: Record<Part, boolean> = {
    0: NAME.test(slug) && !nameError && !folderError && (!importing || !!source.trim()),
    1: existing ? storeUsable(existing) : NAME.test(chosenStoreName) && !storeNameError && (kind === 'sqlite' || (!!url.trim() && !urlError && !loginProblem)),
    2: chosen.length > 0 && chosen.every((m) => offered.some((x) => x.name === m) && pickable(m, blocks)) && stopped.length === 0,
  }
  const valid = !!data && ok[0] && ok[1] && ok[2]

  const plan = (): CreatePlan => ({
    name: slug, kind, store: existing,
    ...(existing ? {} : { newStore: { name: chosenStoreName, ...(kind === 'postgresql' ? { url: url.trim(), login } : {}) } }),
    machines: chosen,
    ...(importing && source.trim() ? { source: source.trim() } : {}),
  })

  const create = async () => {
    if (!valid || running) return
    const p = plan()
    const list = createSteps(p, data).map((step) => ({ step, state: 'pending' as const }))
    setShown(p); setError(null); setFailure(null); setSteps(list); setInitJob(null)
    pane.current?.scrollTo({ top: 0 })
    const mark = (i: number, state: StepState['state']) => setSteps((had) => had?.map((s, j) => (j === i ? { ...s, state } : s)) ?? null)
    const key = `${p.store?.name ?? p.newStore!.name}/${p.name}`
    for (let i = 0; i < list.length; i++) {
      const step = list[i]!.step
      mark(i, 'running')
      try {
        if (step.id === 'open') await api.openProjectSession(key, undefined, undefined, step.machine)
        else await runStep(api, p, step, setInitJob)
        mark(i, 'done')
      } catch (e) {
        mark(i, 'failed')
        setFailure({ step, error: e })
        view.reload()
        return
      }
    }
    onBusy(false)
    projectDialog.close()
  }

  const choose = (next: StoreChoice) => {
    setChoice(next); setStoreName(null); setPgChoice(null); setSqliteMachine(null)
    // a new Store's panel opens under the tiles: bring it into view
    if (next.kind !== 'existing') requestAnimationFrame(() => details.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }
  // Edit on a stopped Create, or a submit with something missing: the name or folder, the Store, else the machine
  const edit = (part: Part) => {
    if (part === 0) { (importing && !source.trim() ? folderInput : nameInput).current?.focus(); return }
    requestAnimationFrame(() => (part === 1 ? details.current ?? storeSection.current : machineSection.current)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }
  const storeKey = existing?.name ?? chosenStoreName
  const keyLine = slug ? <span className={css.mono}>{storeKey ? `${storeKey}/${slug}` : slug}</span> : importing ? t('importSub') : t('newSub')
  const head = <Head title={importing ? t('importTitle') : t('newTitle')} sub={keyLine} t={t} back={running ? undefined : back} />
  // the default Store follows the recent projects: wait for them (or their failure) so it does not jump
  if (!data || (recent.data === undefined && !recent.error)) return <>{head}<div className={css.body}><Loading read={view} t={t} /></div></>

  const partTitles: Record<Part, string> = { 0: t('name'), 1: t('store'), 2: t('stepMachine') }
  // the last-used Store first, then the most recently used, then by name
  const usedAt = new Map<string, number>()
  for (const r of recent.data?.projects ?? []) {
    const s = r.project.split('/')[0] ?? ''
    usedAt.set(s, Math.max(usedAt.get(s) ?? 0, r.lastActivity))
  }
  const ordered = [...stores].sort((a, b) => Number(b.name === last?.name) - Number(a.name === last?.name) || (usedAt.get(b.name) ?? 0) - (usedAt.get(a.name) ?? 0) || a.name.localeCompare(b.name))
  // tiles hold usable Stores only (a broken one shows in All N Stores with its fix)
  const tileStores = capWith(ordered.filter(storeUsable), TILE_CAP, (s) => s.name === existing?.name)
  const moving = kind === 'sqlite' && existing && existing.machine !== chosenSqlite
  const fellBack = choice === null && auto.fellBack && last
  const storeKindOf = (s: StoreRow): StoreKind => (s.kind === 'postgresql' ? 'postgresql' : 'sqlite')
  const countWords = (s: StoreRow) => { const n = s.projectsCount ?? s.projects.length; return n === 1 ? t('oneProject') : t('projects', { n }) }
  const storeNote = (s: StoreRow) => storeKindOf(s) === 'postgresql'
    ? `${t('kindPgTitle')} · ${s.postgresql?.target ?? ''}`
    : `${t('kindSqliteTitle')} · ${machineWord(s.machine ?? '')} · ${s.name === last?.name ? t('lastUsedNote') : countWords(s)}`
  const mlist = kind === 'sqlite' ? machines : offered
  const mvalue = kind === 'sqlite' ? chosenSqlite : chosenPg ?? ''
  const setMachine = kind === 'sqlite' ? setSqliteMachine : setPgChoice
  const mcurrent = kind === 'sqlite' ? existing?.machine ?? null : null
  const mfallback = kind === 'sqlite' && !existing ? fallback : null

  // All N Stores / All N machines: the whole list in place of the form; picking one goes back
  if (sub && !running) {
    const back = () => setSub(null)
    if (sub === 'stores') {
      const groups = new Map<string, ListGroup>()
      for (const s of [...ordered].sort((a, b) => Number(b.name === last?.name) - Number(a.name === last?.name) || a.name.localeCompare(b.name))) {
        const sKind = storeKindOf(s)
        const label = sKind === 'postgresql' ? t('kindPgTitle') : machineWord(s.machine ?? '')
        const fail = sKind === 'postgresql' ? formatSessionFailure(pgStoreFailure(s), null, t, s.name, s) : null
        const broken = !storeUsable(s)
        const g = groups.get(label) ?? { label, items: [] }
        g.items.push({
          key: s.name, mark: <StoreKindGlyph kind={sKind} size={15} />, name: s.name, search: `${s.machine ?? ''} ${s.postgresql?.target ?? ''}`,
          note: fail ? fail.short : sKind === 'postgresql' ? s.postgresql?.target ?? '' : s.name === last?.name ? `${countWords(s)} · ${t('lastUsedNote')}` : countWords(s),
          tone: fail ? 'warn' : undefined, title: fail?.message, selected: existing?.name === s.name, disabled: broken,
          after: broken ? <Button type="button" variant="ghost" size="sm" onClick={() => { projectDialog.close(); openStorage(api, `store:${s.name}`) }}>{t('sfOpenStore')}</Button> : undefined,
          onPick: () => { choose({ kind: 'existing', store: s.name }); back() },
        })
        groups.set(label, g)
      }
      return <>
        <Head title={t('chooseStore')} sub={t('forProject', { name: slug || t('notNamed') })} t={t} onBack={back} />
        <ChoiceList groups={[...groups.values()]} label={t('chooseStore')} placeholder={t('filterStoresList')} empty={t('noStoreMatch')} />
        <ListFoot addLabel={t('newStore')} onAdd={() => { choose({ kind: picked.kind === 'pg' ? 'pg' : 'sqlite' }); back() }} backLabel={t('back')} onBack={back} />
      </>
    }
    return <MachineListView t={t} api={api} machines={mlist} value={mvalue} current={mcurrent} fallback={mfallback} blocks={blocks} words={words}
      sub={t('forProject', { name: slug || t('notNamed') })} onPick={(m) => { setMachine(m); back() }} onBack={back} />
  }

  return <form className={css.form} aria-busy={running}
    onSubmit={(e) => {
      e.preventDefault()
      setAttempted(true)
      const missing = ([0, 1, 2] as const).find((i) => !ok[i])
      if (missing !== undefined) edit(missing); else void create()
    }}>
    {head}
    {/* the div scrolls: a fieldset does not clip its overflow when its height comes from flex */}
    <div ref={pane} className={css.wizard}>
      <fieldset className={css.pane} disabled={running}>
        {steps && shown ? <Progress steps={steps} plan={shown} t={t} failure={failure} initJob={initJob} partTitle={(i) => partTitles[i]} onEdit={edit} /> : null}
        <div className={css.fields}>
          {importing ? <Field label={t('folder')} hint={t('folderHint')} error={folderError} id={`${id}-folder`}
            after={<>
              {pickerMissing ? null : <Button type="button" variant="outline" size="sm" icon={<IconFolderOpenOutlineRegular size={14} />} onClick={() => void browse()}>{t('browse')}</Button>}
              <Button type="button" variant="ghost" size="sm" onClick={() => chooseFrom('empty')}>{t('startEmpty')}</Button>
            </>}>
            <Input id={`${id}-folder`} ref={folderInput} value={source} className={css.mono} placeholder="/Users/me/code/shop" autoComplete="off" spellCheck={false} onChange={(e) => typeSource(e.target.value)} />
          </Field> : null}
          <Field label={t('name')} error={nameError} hint={slug && slug !== name.trim() ? t('savedAs', { slug }) : importing && !nameTyped && source.trim() ? t('nameFollows') : null} id={`${id}-name`}
            after={importing ? undefined : <Button type="button" variant="outline" size="sm" icon={<IconFolderOpenOutlineRegular size={14} />} onClick={() => chooseFrom('folder')}>{t('fromFolderBtn')}</Button>}>
            <Input id={`${id}-name`} ref={nameInput} value={name} placeholder={t('namePlaceholder')} autoComplete="off" spellCheck={false} data-modal-autofocus="" onChange={(e) => { setName(e.target.value); setNameTyped(e.target.value.trim() !== '') }} />
          </Field>

          <section ref={storeSection} className={css.field} aria-labelledby={`${id}-store`}>
            <h3 id={`${id}-store`} className={css.label}>{t('store')}</h3>
            {fellBack ? <SectionNote>{t('lastFellBack', { store: last.name })}</SectionNote> : null}
            {tileStores.length ? <TileGrid label={t('store')}>
              {tileStores.map((s) => <ChoiceTile key={s.name} mark={<StoreKindGlyph kind={storeKindOf(s)} size={15} />} name={s.name} note={storeNote(s)}
                selected={existing?.name === s.name} onSelect={() => choose({ kind: 'existing', store: s.name })} data={{ 'data-store': s.name }} />)}
            </TileGrid> : null}
            <TileActions all={stores.length > tileStores.length ? { label: t('allStores', { n: stores.length }), onClick: () => setSub('stores') } : null}
              add={{ label: t('newStore'), selected: creatingStore, onClick: () => { if (!creatingStore) choose({ kind: 'sqlite' }) } }} />
            {creatingStore ? <div ref={details} className={css.newStorePanel}>
              <div className={css.kindSwitch} role="radiogroup" aria-label={t('storeKind')}>
                {(['sqlite', 'pg'] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={picked.kind === k} className={css.kindOpt}
                  onClick={() => { if (picked.kind !== k) choose({ kind: k }) }}>
                  <StoreKindGlyph kind={k === 'pg' ? 'postgresql' : 'sqlite'} size={13} />{k === 'pg' ? t('kindPgTitle') : t('kindSqliteTitle')}
                </button>)}
              </div>
              <Field label={t('storeName')} error={storeNameError} hint={storeConflictNotice ? null : t('storeNameHint')}>
                <Input value={storeName ?? autoStoreName} className={css.mono} placeholder={autoStoreName || 'projects'} autoComplete="off" spellCheck={false}
                  onChange={(e) => setStoreName(e.target.value)} />
              </Field>
              {storeConflictNotice ? <p className={css.storeConflictNotice} role="status">{t('storeNameAutoHint', { taken: slug, store: chosenStoreName })}</p> : null}
              {kind === 'postgresql' ? <>
                <Field label={t('url')} hint={t('urlHint')} error={urlError}>
                  <Input value={url} className={css.mono} placeholder="postgresql://db.internal:5432/app" autoComplete="off" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
                </Field>
                {linuxLocalhost ? <PgLocalhostNotice message={t('urlLocalhostWarn')} actionLabel={t('urlLocalhostUseIpv4')} onReplace={() => setUrl(replaceLocalhostWithIpv4(url))} /> : null}
                <div className={css.pair}>
                  <Field label={t('user')} error={attempted && loginProblem === 'user' ? t('needUser') : null}>
                    <Input value={pgUser} className={css.mono} autoComplete="off" spellCheck={false} aria-label={t('user')} onChange={(e) => setPgUser(e.target.value)} />
                  </Field>
                  <Field label={t('password')} error={attempted && loginProblem === 'password' ? t('needPassword') : null}>
                    <Input value={pgPassword} className={css.mono} type="password" autoComplete="new-password" spellCheck={false} aria-label={t('password')} onChange={(e) => setPgPassword(e.target.value)} />
                  </Field>
                </div>
                <p className={css.hint}>{t('passwordHint')}</p>
              </> : null}
            </div> : null}
            {attempted && !ok[1] && existing ? <span className={css.error} role="alert">{t('pickStore')}</span> : null}
          </section>

          <section ref={machineSection} className={css.field} aria-labelledby={`${id}-machine`}>
            <h3 id={`${id}-machine`} className={css.label}>{kind === 'sqlite' ? t('stepMachine') : t('sessionRunsOn')}</h3>
            <MachineGrid machines={mlist} value={mvalue} onChange={setMachine} words={words} label={kind === 'sqlite' ? t('stepMachine') : t('sessionRunsOn')}
              current={mcurrent} fallback={mfallback} blocks={blocks}
              allLabel={t('allMachines', { n: mlist.length })} onAll={() => setSub('machines')} newLabel={t('newMachine')} onNew={newMachine(api)} />
            {moving
              ? <SectionNote tone="warn">{t('moveWarn', { store: existing!.name, machine: machineWord(chosenSqlite), n: Math.max(0, existing!.projectsCount ?? existing!.projects.length) })}</SectionNote>
              : willAttach ? <SectionNote>{t('pgWillAttach', { machine: willAttach })}</SectionNote>
                : <SectionNote>{kind === 'sqlite' ? t('locationHint') : t('runsOnPg')}</SectionNote>}
            {offered.length === 0 ? <p className={css.notice}>{t('noMachines')}</p> : null}
            {/* Create starts no machine: each stopped one it needs has its own Start here */}
            <StartFirst names={stopped} words={startWords} start={(m) => startMachine(api, m)} onStarted={view.reload} />
          </section>
        </div>
      </fieldset>
    </div>
    <footer className={css.foot}>
      <span />
      <div className={css.footActions}>
        <Button type="button" variant="outline" disabled={running} onClick={() => projectDialog.close()}>{t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={running || !data} aria-busy={running} icon={running ? <StatusDot state="ongoing" size={13} /> : undefined}>
          {running ? t('creating') : importing ? t('import') : t('create')}
        </Button>
      </div>
    </footer>
  </form>
}

/** All N machines: every machine the section offers, grouped Running, Stopped and Can't run here; picking one goes back. */
function MachineListView({ t, api, machines, value, current, fallback, blocks, words, sub, onPick, onBack }: {
  t: SetupT, api: LayerfsApi, machines: readonly Machine[], value: string, current: string | null, fallback: string | null | undefined
  blocks: ReadonlyMap<string, TileBlock>, words: LocationWords, sub: string, onPick: (machine: string) => void, onBack: () => void
}): ReactNode {
  const groups: ListGroup[] = [{ label: t('grpRunning'), items: [] }, { label: t('grpStopped'), items: [] }, { label: t('grpCantRun'), items: [] }]
  for (const m of machineOrder(machines, current ?? fallback, blocks)) {
    const badge = current ? (m.name === current ? words.here : null) : m.name === fallback ? words.default : null
    const p = machineTileParts(m, words, blocks.get(m.name), badge, value === m.name)
    const g = blocks.has(m.name) || m.state === 'broken' ? 2 : isRunning(m) ? 0 : 1
    groups[g]!.items.push({ key: m.name, mark: p.mark, name: m.name, note: p.note, tone: p.tone, selected: value === m.name, disabled: p.disabled, search: m.platform ?? '', onPick: () => onPick(m.name) })
  }
  return <>
    <Head title={t('chooseMachine')} sub={sub} t={t} onBack={onBack} />
    <ChoiceList groups={groups} label={t('chooseMachine')} placeholder={t('filterMachines')} empty={t('noMachineMatch')} />
    <ListFoot addLabel={t('newMachine')} onAdd={newMachine(api)} backLabel={t('back')} onBack={onBack} />
  </>
}

// ---------- configure ----------

/** Configure: the Store, where it runs (a SQLite Store moves; a PostgreSQL Store's sessions run there), and Hide from sidebar. */
function Configure({ api, t, project, back, onBusy }: { api: LayerfsApi, t: SetupT, project: ProjectRef, back?: DialogRequest | undefined, onBusy: (busy: boolean) => void }): ReactNode {
  const view = useStorage(api)
  const platforms = usePlatforms(api)
  const recent = useRecent(api)
  const [target, setTarget] = useState<string | null>(null)
  const [busy, setBusyState] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)
  const [sub, setSub] = useState(false)
  const name = project.name ?? project.key.split('/')[1] ?? project.key
  const storeName = project.store ?? project.key.split('/')[0] ?? ''
  const store: StoreRow | undefined = view.data?.stores.find((s) => s.name === storeName)
  const setBusy = (value: string | null) => { setBusyState(value); onBusy(!!value) }
  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label); setError(null)
    try { await work(); setTarget(null) } catch (e) { setError(messageOf(e)) } finally { setBusy(null); view.reload() }
  }
  // the head's line: its sessions and when the last one ran (the key, until there is one)
  const mine = (recent.data?.projects ?? []).filter((r) => (project.projectId && r.projectId === project.projectId) || r.project === project.key)
  const sessions = mine.reduce((n, r) => n + r.sessionIds.length, 0)
  const lastAt = mine.reduce((at, r) => Math.max(at, r.lastActivity), 0)
  const headLine = sessions && lastAt
    ? t('sessionsLast', { sessions: sessions === 1 ? t('oneSession') : t('sessions', { n: sessions }), ago: agoWords(lastAt, t) })
    : <span className={css.mono}>{project.key}</span>
  const head = <Head title={name} sub={headLine} subTitle={project.key} t={t} back={busy ? undefined : back} />
  const hide = hidden ? <span className={css.footNote}>{t('hidden')}</span>
    : <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => { sidebarHidden.hide(project.projectId ?? project.key); setHidden(true) }}>{t('hide')}</Button>
  if (!view.data) return <>{head}<div className={css.body}><Loading read={view} t={t} /></div></>
  if (!store) {
    return <>{head}
      <div className={css.body}><p className={css.notice}>{t('storeMissing')}</p></div>
      <footer className={css.foot}>{hide}<div className={css.footActions}>
        <Button variant="outline" onClick={() => { projectDialog.close(); openStorage(api) }}>{t('openResources')}</Button>
        <Button variant="primary" onClick={() => projectDialog.close()}>{t('done')}</Button>
      </div></footer>
    </>
  }
  const others = Math.max(0, store.projects.length - 1)
  const pg = store.kind === 'postgresql'
  const machines = machinesFor(view.data, pg ? 'postgresql' : 'sqlite')
  const blocks = tileBlocks(view.data.machines, platforms, view.data.computer?.os)
  const startWords = startWordsOf(t)
  const kindWords = pg ? t('kindPg') : t('kindSqlite')
  const pgFail = pg ? formatSessionFailure(pgStoreFailure(store), null, t, store.name, store) : null
  const storeCard = <section className={css.field}>
    <div className={css.labelRow}>
      <h3 className={css.label}>{t('store')}</h3>
      <button type="button" className={css.labelLink} onClick={() => { projectDialog.close(); openStorage(api, `store:${store.name}`) }}>{t('sfOpenStore')}</button>
    </div>
    <div className={css.storeCard}>
      <span className={css.tileMark} aria-hidden="true"><StoreKindGlyph kind={store.kind} size={18} /></span>
      <span className={css.kindText}>
        <span className={css.storeCardHead}>
          <span className={css.kindName}>{store.name}</span>
          {pg && pgFail ? <span className={clsx(css.storeStatusTag, store.state === 'broken' ? css.storeStatusError : css.storeStatusWarn)}>{pgFail.short}</span>
            : pg && store.state === 'ready' ? <span className={css.storeStatusReady}>{t('pgReadyBadge')}</span> : null}
        </span>
        <span className={css.kindBlurb}>{[kindWords, pg ? store.postgresql?.target : null, store.size ? bytes(store.size.bytes) : null, others === 1 ? t('sharedOne') : others ? t('shared', { n: others }) : t('alone')].filter(Boolean).join(' · ')}</span>
      </span>
    </div>
    {pgFail ? <p className={clsx(css.pgStoreNotice, store.state === 'broken' && css.pgStoreNoticeError)} role="alert">{pgFail.message}</p> : null}
  </section>

  const words = wordsOf(t, view.data?.computer?.os)
  if (!pg) {
    const current = store.machine ?? ''
    const chosen = target ?? current
    if (sub && !busy) {
      return <MachineListView t={t} api={api} machines={machines} value={chosen} current={current} fallback={null} blocks={blocks} words={words}
        sub={name} onPick={(m) => { setTarget(m === current ? null : m); setSub(false) }} onBack={() => setSub(false)} />
    }
    return <>{head}
      <div className={css.body}><div className={css.fields}>
        {storeCard}
        <section className={css.field}>
          <h3 className={css.label}>{t('stepMachine')}</h3>
          <MachineGrid machines={machines} value={chosen} onChange={(m) => setTarget(m === current ? null : m)} words={words} label={t('stepMachine')} current={current}
            disabled={!!busy} blocks={blocks} allLabel={t('allMachines', { n: machines.length })} onAll={() => setSub(true)} newLabel={t('newMachine')} onNew={newMachine(api)} />
          {chosen !== current
            ? <SectionNote tone="warn">{t('moveWarn', { store: store.name, machine: isHostName(chosen) ? t(hostWordKey(view.data.computer?.os)) : chosen, n: others })}</SectionNote>
            : <SectionNote>{t('locationHint')}</SectionNote>}
          {/* moving starts no machine: each stopped one it needs has its own Start here */}
          {chosen !== current ? <StartFirst names={stoppedOf([current, chosen], view.data)} words={startWords} start={(m) => startMachine(api, m)} onStarted={view.reload} /> : null}
          {error ? <p className={css.error} role="alert">{error}</p> : null}
        </section>
      </div></div>
      <footer className={css.foot}>
        {hide}
        <div className={css.footActions}>
          {chosen !== current
            ? <>
              <Button variant="outline" disabled={!!busy} onClick={() => setTarget(null)}>{t('cancel')}</Button>
              <Button variant="primary" disabled={!!busy || stoppedOf([current, chosen], view.data).length > 0} icon={busy ? <StatusDot state="ongoing" size={13} /> : undefined}
                onClick={() => void run('move', () => placeStore(api, store.name, chosen))}>
                {busy ? t('moving') : t('moveTo', { machine: chosen })}
              </Button>
            </>
            : <Button variant="primary" onClick={() => projectDialog.close()}>{t('done')}</Button>}
        </div>
      </footer>
    </>
  }
  // a PostgreSQL Store has no machine of its own: each session runs on one of the machines attached to it
  const reaches = store.attached ?? []
  return <>{head}
    <div className={css.body}><div className={css.fields}>
      {storeCard}
      <Group label={t('runsOn')} hint={t('pgPlacedPerSession')}>
        {reaches.length ? (
          <div className={css.reachList}>
            {reaches.map((c) => {
              const machine = c.machine
              const mInfo = view.data?.machines.find((m) => m.name === machine)
              const err = c.reach?.error ?? null
              const statusText = c.reached === 'ok'
                ? (c.reach?.latencyMs != null ? t('pgReachOk', { ms: c.reach.latencyMs }) : t('pgReachOkPlain'))
                : c.reached === 'failed'
                  ? t('pgReachFailed')
                  : t('pgReachUnchecked')
              return <span key={machine} className={css.reachChip} data-reach={c.reached} title={err ?? undefined}>
                <MachineGlyph platform={mInfo?.platform ?? 'unknown'} size={12} mono />
                <span>{machine}</span>
                <span className={css.reachSep} aria-hidden="true">·</span>
                <span className={css.reachState}>{statusText}</span>
              </span>
            })}
          </div>
        ) : <p className={css.notice}>{t('pgNotConnectedYet')}</p>}
      </Group>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </div></div>
    <footer className={css.foot}>
      {hide}
      <div className={css.footActions}>
        <Button variant="primary" disabled={!!busy} onClick={() => projectDialog.close()}>{t('done')}</Button>
      </div>
    </footer>
  </>
}

// ---------- pick ----------

const nameOf = (p: ProjectRow) => p.name ?? p.key.split('/')[1] ?? p.key
const storeOf = (p: ProjectRow) => p.store ?? p.key.split('/')[0] ?? ''
const idOf = (p: ProjectRow) => p.projectId ?? p.key
const PICK: DialogRequest = { mode: 'pick' }

/** Pick: every project, searchable; a row starts a session, ⚙ sets it up. */
function Pick({ api, t, tl }: { api: LayerfsApi, t: SetupT, tl: ListT }): ReactNode {
  const data = useProjectData(api)
  const recent = useRecent(api)
  const [query, setQuery] = useState('')
  const counts = useMemo(() => {
    const out = new Map<string, number>()
    for (const r of recent.data?.projects ?? []) for (const k of [r.projectId, r.project]) if (k) out.set(k, (out.get(k) ?? 0) + r.sessionIds.length)
    return out
  }, [recent.data])
  const q = query.trim().toLowerCase()
  const rows = (data.catalog.data?.rows ?? []).filter((p) => p.key !== data.scratchKey)
  const items = rows.filter((p) => !q || nameOf(p).toLowerCase().includes(q) || storeOf(p).toLowerCase().includes(q)).map(data.item)
  const sessionsOf = (p: ProjectRow) => counts.get(p.projectId ?? '') ?? counts.get(p.key) ?? 0
  // Projects that can run first, most used first, then by name.
  const rank = (i: ProjectItem) => (i.availability.canRun || i.availability.canStart ? 0 : i.row.catalogState === 'removed' || i.row.catalogState === 'identity-mismatch' ? 2 : 1)
  items.sort((a, b) => rank(a) - rank(b) || sessionsOf(b.row) - sessionsOf(a.row) || nameOf(a.row).localeCompare(nameOf(b.row)))
  return <>
    <Head title={t('pickTitle')} sub={t('pickSub')} t={t} />
    <div className={css.searchRow}>
      <IconSearchOutlineRegular size={15} className={css.searchIcon} />
      <input className={css.search} value={query} placeholder={t('search')} aria-label={t('search')} data-modal-autofocus="" onChange={(e) => setQuery(e.target.value)} />
    </div>
    <div className={clsx(css.body, css.pickBody)}>
      {data.catalog.error && !data.catalog.data ? <Loading read={{ error: data.catalog.error, reload: data.reload }} t={t} />
        : !data.catalog.data ? <div className={css.notice}>{t('loading')}</div>
          : !items.length ? <div className={css.notice}>{q ? t('noMatch') : t('noProjects')}</div>
            : <ul className={css.picks} aria-label={t('pickTitle')}>
              {items.map((item) => <PickRow key={idOf(item.row)} api={api} t={t} tl={tl} item={item} sessions={sessionsOf(item.row)} onChanged={data.reload} platformOf={data.platformOf} />)}
            </ul>}
    </div>
    <footer className={css.foot}>
      <div className={css.footActions}>
        <Button variant="ghost" icon={<IconFolderOpenOutlineRegular size={14} />} onClick={() => projectDialog.open({ mode: 'import', back: PICK })}>{t('importFolder')}</Button>
      </div>
      <div className={css.footActions}>
        <Button variant="primary" icon={<IconPlusOutlineRegular size={14} />} onClick={() => projectDialog.open({ mode: 'new', back: PICK })}>{t('newProject')}</Button>
      </div>
    </footer>
  </>
}

function PickRow({ api, t, tl, item, sessions, onChanged, platformOf }: { api: LayerfsApi, t: SetupT, tl: ListT, item: ProjectItem, sessions: number, onChanged: () => void, platformOf: (machine: string) => string }): ReactNode {
  const { row, availability } = item
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = nameOf(row)
  const status = sidebarStatus(row, availability)
  const startGuard = usePressGuard(`start:${availability.machine ?? ''}:${availability.state}`)
  const configure = () => projectDialog.open({ mode: 'configure', project: { key: row.key, projectId: row.projectId, name, store: storeOf(row) }, back: PICK })
  const go = async (work: () => Promise<unknown>, message: (m: string) => string, close: boolean) => {
    setBusy(true); setError(null)
    try { await work(); if (close) projectDialog.close(); else onChanged() } catch (e) { setError(message(messageOf(e))) } finally { setBusy(false) }
  }
  const open = () => { if (availability.canRun && !busy) void go(() => api.openProjectSession(row.key, undefined, row.projectId), (m) => t('openFailed', { message: m }), true) }
  return <li className={css.pick} data-layerfs-project={idOf(row)}>
    <button type="button" className={css.pickMain} disabled={!availability.canRun || busy} onClick={open}
      aria-label={t('newSession', { project: `${name} · ${storeOf(row)}` })} title={`${name} · ${storeOf(row)}`}>
      <span className={css.pickMark}><LayerfsGlyph size={18} /></span>
      <span className={css.pickText}>
        <span className={css.pickName}>{name}</span>
        <span className={css.pickMeta}>
          <span>{storeOf(row)}</span>
          {item.runsOn.length ? <span className={css.pickSep} aria-hidden="true">·</span> : null}
          {item.runsOn.map((m) => <span key={m} className={css.pickMachine}><MachineGlyph platform={platformOf(m)} size={11} mono />{m}</span>)}
        </span>
      </span>
      {!availability.canRun && availability.state !== 'checking'
        ? <span className={css.why}>{tl(status.key)}</span>
        : <span className={css.count}>{sessions === 1 ? t('oneSession') : t('sessions', { n: sessions })}</span>}
    </button>
    {availability.canStart
      ? <Button variant="outline" size="sm" disabled={busy || startGuard.settling} aria-disabled={startGuard.settling || undefined} aria-label={t('startFor', { machine: availability.machine ?? '', project: name })}
        onClick={startGuard(() => void go(() => api.call('POST', `/api/machines/${enc(availability.machine!)}/start`), (m) => t('startFailed', { machine: availability.machine ?? '', message: m }), false))}>{t('startNamed', { machine: availability.machine ?? '' })}</Button>
      : null}
    <Button variant="ghost" size="sm" className={css.pickGear} icon={<IconSettingsOutlineRegular size={15} />} aria-label={t('configure', { project: name })} title={t('configure', { project: name })} onClick={configure} />
    {error ? <p className={css.pickError} role="alert">{error}</p> : null}
  </li>
}
