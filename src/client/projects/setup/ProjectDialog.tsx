/**
 * The project dialog (docs/specs/layerfs-workspaces.md §2-§4): one modal that
 * creates or imports a project in three steps (Project, Store, Runs on, on a
 * left rail), configures where one runs, and picks a project to start a
 * session in. SQLite runs on one machine (place = push / pull / move);
 * PostgreSQL on any number (attach / detach). Docker is the default.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutlineRegular, IconChevronLeftOutlineRegular, IconCloseOutlineRegular, IconFolderOpenOutlineRegular,
  IconPlusOutlineRegular, IconSearchOutlineRegular, IconSettingsOutlineRegular, Input, Modal, SegmentedControl, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../../api.ts'
import { useQuery } from '../../files/use-query.ts'
import { MachineGlyph, StoreKindGlyph } from '../../machines/icons.tsx'
import { LayerfsGlyph } from '../../overview/glyph.tsx'
import { messageOf, NAME, type ProjectRow } from '../../picker/NewProjectForm.tsx'
import { slugify } from '../../picker/location.ts'
import { useHostEvents } from '../../storage/hooks.ts'
import type { StorageView, StoreRow } from '../../storage/types.ts'
import { projectDialog, type DialogRequest, type ProjectRef } from '../dialog.ts'
import type { ListT } from '../list-locale.ts'
import { openStorage } from '../navigation.ts'
import { useProjectData, useRecent, type ProjectItem } from '../ProjectList.tsx'
import { sidebarStatus } from '../readiness.ts'
import { sidebarHidden } from '../recent.ts'
import type { SetupT } from './locale.ts'
import { attachedMachines, createSteps, defaultMachine, freeStoreName, isRunning, machinesFor, type CreatePlan, type Machine, type Step, type StoreKind } from './model.ts'
import { attachStore, detachStore, placeStore, runStep, startMachine } from './run.ts'
import css from './dialog.module.css'

const PG_URL = /^postgres(?:ql)?:\/\//i
const PG_URL_PASSWORD = /^postgres(?:ql)?:\/\/[^/@?]*:[^/@?]*@|[?&][^=&]*password=/i
const enc = encodeURIComponent

/** `/api/storage`, refreshed on storage and machine events. */
export function useStorage(api: LayerfsApi) {
  const read = useQuery(() => api.call<StorageView>('GET', '/api/storage'), [api])
  useHostEvents(api, ['storage', 'storage-job', 'machine-progress', 'connection', 'layerfs-availability'], read.reload)
  return read
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
      : <Create api={api} t={t} importing={request.mode === 'import'} back={back} onBusy={setBusy} />
  const title = request.mode === 'configure' ? request.project.name ?? request.project.key.split('/')[1] ?? request.project.key
    : request.mode === 'pick' ? t('pickTitle') : request.mode === 'import' ? t('importTitle') : t('newTitle')
  return <Modal open headless onClose={close} title={title} className={css.dialog}>
    {body}
  </Modal>
}

/** The dialog's head: Back (when opened from the picker), the LayerFS mark, the title, a line under it, and Close. */
function Head({ title, sub, t, back }: { title: string, sub: ReactNode, t: SetupT, back?: DialogRequest | undefined }): ReactNode {
  return <header className={css.head}>
    {back
      ? <button type="button" className={css.back} onClick={() => projectDialog.open(back)}>
        <IconChevronLeftOutlineRegular size={14} /><span>{t('backToProjects')}</span>
      </button>
      : null}
    <div className={css.headRow}>
      <span className={css.headTile} aria-hidden="true"><LayerfsGlyph size={20} /></span>
      <span className={css.headText}>
        <h2 className={css.title}>{title}</h2>
        <span className={css.sub}>{sub}</span>
      </span>
      <Button variant="ghost" size="sm" className={css.close} icon={<IconCloseOutlineRegular size={16} />} aria-label={t('close')} title={t('close')}
        onClick={() => projectDialog.close()} />
    </div>
  </header>
}

function Loading({ read, t }: { read: { error: unknown, reload: () => void }, t: SetupT }): ReactNode {
  return read.error
    ? <div className={css.notice} role="alert">{t('loadFailed', { message: messageOf(read.error) })} <Button variant="ghost" size="sm" onClick={read.reload}>{t('retry')}</Button></div>
    : <div className={css.notice}>{t('loading')}</div>
}

/** A labelled control: every field in the dialog shares this label, hint and error. */
function Field({ label, hint, error, children }: { label: string, hint?: string | null | undefined, error?: string | null | undefined, children: ReactNode }): ReactNode {
  return <div className={css.field} data-invalid={error ? '' : undefined}>
    <label className={css.field}><span className={css.label}>{label}</span>{children}</label>
    {error ? <span className={css.error} role="alert">{error}</span> : hint ? <span className={css.hint}>{hint}</span> : null}
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

function Tick({ on, square }: { on: boolean, square?: boolean }): ReactNode {
  return <span className={clsx(css.tick, square && css.tickSquare, on && css.tickOn)} aria-hidden="true">{on ? <IconCheckOutlineRegular size={11} /> : null}</span>
}

/** One Store kind as a card: its mark, name and what it means. */
function KindCard({ kind, selected, t, onSelect }: { kind: StoreKind, selected: boolean, t: SetupT, onSelect: () => void }): ReactNode {
  return <button type="button" role="radio" aria-checked={selected} className={clsx(css.kind, selected && css.selected)} onClick={onSelect}>
    <span className={css.kindMark}><StoreKindGlyph kind={kind} size={20} /></span>
    <span className={css.kindText}>
      <span className={css.kindName}>{kind === 'sqlite' ? t('kindSqliteTitle') : t('kindPgTitle')}</span>
      <span className={css.kindBlurb}>{kind === 'sqlite' ? t('kindSqliteBlurb') : t('kindPgBlurb')}</span>
    </span>
    <Tick on={selected} />
  </button>
}

/** A machine's words: Running, Stopped, This Mac · no isolation. */
function machineNote(m: Machine, t: SetupT): string {
  if (m.name === 'native') return t('thisMac')
  if (isRunning(m)) return t('running')
  if (m.state === 'stopped') return t('stopped')
  return m.state ?? ''
}

/** The chosen machines that are stopped (native never is). */
function stoppedPicked(names: readonly string[], machines: readonly Machine[]): string[] {
  return names.filter((n) => { const m = machines.find((x) => x.name === n); return !!m && !isRunning(m) })
}

/** One machine as a tile: its mark, name, state and a badge (Default, Here now). */
function MachineTile({ m, selected, multi, note, badge, onSelect, disabled, working }: {
  m: Machine, selected: boolean, multi: boolean, note: string, badge?: string | null, onSelect: () => void, disabled?: boolean, working?: boolean
}): ReactNode {
  return <button type="button" role={multi ? 'checkbox' : 'radio'} aria-checked={selected} disabled={disabled}
    className={clsx(css.machine, selected && css.selected)} onClick={onSelect} data-machine={m.name}
    aria-label={[m.name, note, badge].filter(Boolean).join(', ')}>
    <span className={css.machineTop}>
      <span className={css.machineMark}><MachineGlyph platform={m.platform || m.name} size={18} /></span>
      {badge ? <span className={css.badge}>{badge}</span> : null}
      {working ? <StateDot state="ongoing" size={11} /> : <Tick on={selected} square={multi} />}
    </span>
    <span className={css.machineName}>{m.name}</span>
    <span className={css.machineNote}>
      {m.name !== 'native' ? <span className={css.dot} data-on={isRunning(m) || undefined} aria-hidden="true" /> : null}
      <span>{note}</span>
    </span>
  </button>
}

function NewMachineTile({ api, t }: { api: LayerfsApi, t: SetupT }): ReactNode {
  return <button type="button" className={clsx(css.machine, css.newMachine)} onClick={() => { projectDialog.close(); openStorage(api, 'machines:new') }}>
    <IconPlusOutlineRegular size={16} />
    <span>{t('newMachine')}</span>
  </button>
}

type StepState = { step: Step, state: 'pending' | 'running' | 'done' | 'failed' }

function stepLabel(step: Step, plan: CreatePlan, t: SetupT): string {
  const store = plan.store?.name ?? plan.newStore?.name ?? ''
  const id = step.id
  if (id === 'store') return t('step_store', { store })
  if (id === 'connect') return t('step_connect', { store })
  if (id === 'init') return t('step_init', { name: plan.name })
  if (id === 'open') return t('step_open')
  if (id === 'detach:native') return t('step_detach', { store })
  if (id === 'start-store' || id.startsWith('start:')) return t('step_start', { machine: step.machine ?? '' })
  if (id.startsWith('place:')) return t('step_place', { store, machine: step.machine ?? '' })
  return t('step_attach', { store, machine: step.machine ?? '' })
}

function Progress({ steps, plan, t, error }: { steps: StepState[], plan: CreatePlan, t: SetupT, error: string | null }): ReactNode {
  return <div className={css.progress} aria-live="polite">
    <h3 className={css.label}>{error ? t('createStopped') : t('creating')}</h3>
    <ol className={css.steps}>
      {steps.map(({ step, state }) => <li key={step.id} className={css.step} data-state={state}>
        <span className={css.stepMark} aria-hidden="true">{state === 'running' ? <StateDot state="ongoing" size={10} /> : state === 'done' ? <IconCheckOutlineRegular size={11} /> : state === 'failed' ? <IconCloseOutlineRegular size={11} /> : null}</span>
        <span>{stepLabel(step, plan, t)}</span>
      </li>)}
    </ol>
    {error ? <p className={css.error} role="alert">{error}</p> : null}
  </div>
}

// ---------- create ----------

type Part = 0 | 1 | 2
const PARTS = [0, 1, 2] as const
type StoreMode = 'new' | 'existing'

/** One part on the rail: ready (a check) or not (its number), its title and what was chosen or is missing. Click jumps to it. */
function RailStep({ index, title, summary, current, ready, onSelect, disabled }: {
  index: number, title: string, summary: string, current: boolean, ready: boolean, onSelect: () => void, disabled: boolean
}): ReactNode {
  return <li>
    <button type="button" className={clsx(css.railStep, current && css.railCurrent)} aria-current={current ? 'location' : undefined} disabled={disabled} onClick={onSelect}
      data-ready={ready || undefined}>
      <span className={clsx(css.railMark, ready && css.railDone)} aria-hidden="true">
        {ready ? <IconCheckOutlineRegular size={11} /> : index + 1}
      </span>
      <span className={css.railText}>
        <span className={css.railTitle}>{title}</span>
        <span className={css.railSummary}>{summary}</span>
      </span>
    </button>
  </li>
}

/**
 * Create (or import): Project, Store and Runs on on one scrolling page; the rail
 * shows whether each is ready and jumps to it. Create runs the steps and opens a session.
 */
function Create({ api, t, importing, back, onBusy }: { api: LayerfsApi, t: SetupT, importing: boolean, back?: DialogRequest | undefined, onBusy: (busy: boolean) => void }): ReactNode {
  const id = useId()
  const view = useStorage(api)
  const scratch = useQuery(() => api.op<{ scratchKey?: string | null }>('projects.catalog').catch(() => ({ scratchKey: null })), [api])
  const [active, setActive] = useState<Part>(0)
  const pane = useRef<HTMLFieldSetElement>(null)
  const sections = useRef<(HTMLElement | null)[]>([])
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [pickerMissing, setPickerMissing] = useState(false)
  const [kind, setKind] = useState<StoreKind>('sqlite')
  const [mode, setMode] = useState<StoreMode>('new')
  const [picked, setPicked] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [storeName, setStoreName] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [password, setPassword] = useState('')
  const [sqliteMachine, setSqliteMachine] = useState<string | null>(null)
  const [pgMachines, setPgMachines] = useState<string[] | null>(null)
  const [steps, setSteps] = useState<StepState[] | null>(null)
  const [shown, setShown] = useState<CreatePlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scratchStore = scratch.data?.scratchKey?.split('/')[0]

  const data = view.data
  const machines = machinesFor(data, kind)
  const fallback = defaultMachine(machines)
  const stores = (data?.stores ?? []).filter((s) => s.kind === kind && s.name !== scratchStore)
  const existing = mode === 'existing' ? stores.find((s) => s.name === picked) ?? null : null
  const slug = slugify(name)
  const newStoreName = storeName ?? freeStoreName(slug || 'project', data)
  const chosenSqlite = sqliteMachine ?? (existing?.machine ?? fallback)
  const chosenPg = pgMachines ?? (existing ? attachedMachines(existing).filter((m) => machines.some((x) => x.name === m)) : [fallback])
  const chosen = kind === 'sqlite' ? [chosenSqlite] : chosenPg
  const running = steps !== null && !error
  useEffect(() => { onBusy(running) }, [running])

  const browse = async () => {
    try { const path = await api.pickDirectory(); if (path) { setSource(path); if (!name) setName(path.replace(/\/+$/, '').split('/').pop() ?? '') } }
    catch (e) { if ((e as { code?: string })?.code === 'no-picker') setPickerMissing(true); else setError(messageOf(e)) }
  }
  useEffect(() => { if (importing) void browse() }, [importing])

  const nameError = name.trim() && !NAME.test(slug) ? t('nameInvalid') : null
  const folderError = importing && source.trim() && !source.trim().startsWith('/') ? t('folderInvalid') : null
  const storeNameError = mode === 'new' && storeName !== null
    ? (!NAME.test(storeName) ? t('storeNameInvalid') : data?.stores.some((s) => s.name === storeName) ? t('storeTaken', { store: storeName }) : null) : null
  const urlError = kind === 'postgresql' && mode === 'new' && url.trim() ? (!PG_URL.test(url.trim()) || PG_URL_PASSWORD.test(url.trim()) ? t('urlInvalid') : null) : null
  const ok: Record<Part, boolean> = {
    0: NAME.test(slug) && !nameError && !folderError && (!importing || !!source.trim()),
    1: mode === 'existing' ? !!existing : NAME.test(newStoreName) && !storeNameError && (kind === 'sqlite' || (!!url.trim() && !urlError && !!password.trim())),
    2: chosen.length > 0 && chosen.every(Boolean),
  }
  const valid = !!data && ok[0] && ok[1] && ok[2]

  const plan = (): CreatePlan => ({
    name: slug, kind, store: existing,
    ...(existing ? {} : { newStore: { name: newStoreName, ...(kind === 'postgresql' ? { url: url.trim(), password } : {}) } }),
    machines: chosen,
    ...(importing && source.trim() ? { source: source.trim() } : {}),
  })

  const create = async () => {
    if (!valid || running) return
    const p = plan()
    const list = createSteps(p, data).map((step) => ({ step, state: 'pending' as const }))
    setShown(p); setError(null); setSteps(list)
    pane.current?.scrollTo({ top: 0 })
    const mark = (i: number, state: StepState['state']) => setSteps((had) => had?.map((s, j) => (j === i ? { ...s, state } : s)) ?? null)
    const key = `${p.store?.name ?? p.newStore!.name}/${p.name}`
    for (let i = 0; i < list.length; i++) {
      const step = list[i]!.step
      mark(i, 'running')
      try {
        if (step.id === 'open') await api.openProjectSession(key)
        else await runStep(api, p, step)
        mark(i, 'done')
      } catch (e) {
        mark(i, 'failed')
        setError(t('failed', { step: stepLabel(step, p, t), message: messageOf(e) }))
        view.reload()
        return
      }
    }
    onBusy(false)
    projectDialog.close()
  }

  const chooseKind = (next: StoreKind) => { setKind(next); setMode('new'); setPicked(null); setQuery(''); setPgMachines(null); setSqliteMachine(null) }
  const chooseMode = (next: StoreMode) => {
    setMode(next); setPgMachines(null); setSqliteMachine(null)
    if (next === 'existing' && !stores.some((s) => s.name === picked)) setPicked(stores[0]?.name ?? null)
  }
  const head = <Head title={importing ? t('importTitle') : t('newTitle')} sub={importing ? t('importSub') : t('newSub')} t={t} back={running ? undefined : back} />
  if (!data) return <>{head}<div className={css.body}><Loading read={view} t={t} /></div></>

  const kindWord = kind === 'sqlite' ? t('kindSqliteTitle') : t('kindPgTitle')
  const summaries: Record<Part, string> = {
    0: ok[0] ? slug : importing && !source.trim() ? t('needFolder') : t('notNamed'),
    1: !ok[1] ? (mode === 'existing' ? t('pickStore') : kind === 'postgresql' ? t('needConnection') : t('needStoreName'))
      : existing ? `${kindWord} · ${existing.name}` : `${kindWord} · ${t('newWord')} · ${newStoreName}`,
    2: ok[2] ? chosen.join(', ') : t('noneChosen'),
  }
  const railTitles: Record<Part, string> = { 0: t('stepProject'), 1: t('store'), 2: t('stepMachine') }
  const titles: Record<Part, string> = { 0: t('stepProject'), 1: t('store'), 2: t('runsOn') }
  const q = query.trim().toLowerCase()
  const listed = stores.filter((s) => !q || s.name.toLowerCase().includes(q) || (s.postgresql?.target ?? '').toLowerCase().includes(q))
  const moving = kind === 'sqlite' && existing && (existing.machine ?? 'native') !== chosenSqlite
  const jump = (i: Part) => {
    const root = pane.current, target = sections.current[i]
    if (!root || !target) return
    setActive(i)
    root.scrollTo({ top: Math.max(0, target.offsetTop - 12), behavior: 'smooth' })
  }
  // The part on screen: the last one whose heading has reached the top, the last one at the bottom.
  const spy = () => {
    const root = pane.current
    if (!root) return
    if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) { setActive(2); return }
    let on: Part = 0
    for (const i of PARTS) { const el = sections.current[i]; if (el && el.offsetTop - root.scrollTop <= 48) on = i }
    setActive(on)
  }
  const firstMissing = PARTS.find((i) => !ok[i])

  return <form className={css.form} aria-busy={running}
    onSubmit={(e) => { e.preventDefault(); if (firstMissing !== undefined) jump(firstMissing); else void create() }}>
    {head}
    <div className={css.wizard}>
      <nav className={css.rail} aria-label={t('steps')}>
        <ol className={css.railList}>
          {PARTS.map((i) => <RailStep key={i} index={i} title={railTitles[i]} summary={summaries[i]} current={active === i} ready={ok[i]}
            disabled={running} onSelect={() => jump(i)} />)}
        </ol>
      </nav>
      <fieldset ref={pane} className={css.pane} disabled={running} onScroll={spy}>
        {steps && shown ? <Progress steps={steps} plan={shown} t={t} error={error} /> : null}
        <section ref={(el) => { sections.current[0] = el }} className={css.part} aria-labelledby={`${id}-p0`}>
          <h3 id={`${id}-p0`} className={css.partTitle}>{titles[0]}</h3>
          <div className={css.fields}>
          {importing ? <Field label={t('folder')} hint={t('folderHint')} error={folderError}>
            <span className={css.inline}>
              <Input value={source} className={css.mono} autoComplete="off" spellCheck={false} onChange={(e) => setSource(e.target.value)} />
              {pickerMissing ? null : <Button type="button" variant="outline" size="sm" icon={<IconFolderOpenOutlineRegular size={14} />} onClick={() => void browse()}>{t('browse')}</Button>}
            </span>
          </Field> : null}
          <Field label={t('name')} error={nameError} hint={!nameError && slug && slug !== name.trim() ? t('savedAs', { slug }) : t('nameHint')}>
            <Input value={name} placeholder={t('namePlaceholder')} autoComplete="off" spellCheck={false} data-modal-autofocus="" onChange={(e) => setName(e.target.value)} />
          </Field>
          </div>
        </section>

        <section ref={(el) => { sections.current[1] = el }} className={css.part} aria-labelledby={`${id}-p1`}>
          <h3 id={`${id}-p1`} className={css.partTitle}>{titles[1]}</h3>
          <div className={css.fields}>
          <Group label={t('storeKind')}>
            <div className={css.kinds} role="radiogroup" aria-label={t('storeKind')}>
              {(['sqlite', 'postgresql'] as const).map((k) => <KindCard key={k} kind={k} t={t} selected={kind === k} onSelect={() => chooseKind(k)} />)}
            </div>
          </Group>
          <Group label={t('store')}>
            <SegmentedControl<StoreMode> id={`${id}-mode`} className={css.modes} value={mode} label={t('store')} onChange={chooseMode}
              options={[
                { value: 'new', label: kind === 'sqlite' ? t('newStore') : t('newConnection') },
                { value: 'existing', label: t('existingCount', { n: stores.length }) },
              ]} />
          </Group>
          {mode === 'new' ? <>
            <Field label={t('storeName')} error={storeNameError} hint={kind === 'sqlite' ? t('newSqliteNote') : t('newConnectionNote')}>
              <Input value={newStoreName} autoComplete="off" spellCheck={false} onChange={(e) => setStoreName(e.target.value)} />
            </Field>
            {kind === 'postgresql' ? <>
              <Field label={t('url')} hint={t('urlHint')} error={urlError}>
                <Input value={url} className={css.mono} placeholder="postgres://app@db.lan:5432/app" autoComplete="off" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
              </Field>
              <Field label={t('password')} hint={t('passwordHint')}>
                <Input value={password} type="password" autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
              </Field>
            </> : null}
          </> : stores.length === 0
            ? <p className={css.empty}>{kind === 'sqlite' ? t('noSqlite') : t('noPg')}</p>
            : <div className={css.storeList}>
              <div className={css.storeSearch}>
                <IconSearchOutlineRegular size={14} className={css.searchIcon} />
                <input className={css.search} value={query} placeholder={t('searchStores', { n: stores.length })} aria-label={t('searchStores', { n: stores.length })}
                  onChange={(e) => setQuery(e.target.value)} />
              </div>
              <div role="radiogroup" aria-label={t('store')}>
                {listed.map((s) => <button key={s.name} type="button" role="radio" aria-checked={existing?.name === s.name}
                  className={clsx(css.storeRow, existing?.name === s.name && css.storeRowOn)}
                  onClick={() => { setPicked(s.name); setPgMachines(null); setSqliteMachine(null) }}>
                  <span className={css.storeName}>{s.name}</span>
                  <span className={css.storeNote}>
                    {kind === 'sqlite' ? (s.machine ?? 'native') : s.postgresql?.target ?? ''}
                    {' · '}{s.projects.length === 1 ? t('oneProject') : t('projects', { n: s.projects.length })}
                  </span>
                  {existing?.name === s.name ? <IconCheckOutlineRegular size={14} className={css.storeCheck} /> : null}
                </button>)}
                {listed.length === 0 ? <p className={css.empty}>{t('noStoreMatch')}</p> : null}
              </div>
            </div>}
          </div>
        </section>

        <section ref={(el) => { sections.current[2] = el }} className={css.part} aria-labelledby={`${id}-p2`}>
          <h3 id={`${id}-p2`} className={css.partTitle}>{titles[2]}</h3>
          <div className={css.fields}>
          <Group label={t('machines')} hint={kind === 'sqlite' ? t('runsOnOne') : t('runsOnMany')}>
            <div className={css.machines} role={kind === 'sqlite' ? 'radiogroup' : 'group'} aria-label={t('runsOn')}>
              {machines.map((m) => {
                const here = existing && kind === 'sqlite' && (existing.machine ?? 'native') === m.name
                const badge = here ? t('here') : !existing && m.name === fallback ? t('default') : null
                return kind === 'sqlite'
                  ? <MachineTile key={m.name} m={m} multi={false} selected={chosenSqlite === m.name} note={machineNote(m, t)} badge={badge} onSelect={() => setSqliteMachine(m.name)} />
                  : <MachineTile key={m.name} m={m} multi selected={chosenPg.includes(m.name)} note={machineNote(m, t)} badge={badge}
                    onSelect={() => setPgMachines(chosenPg.includes(m.name) ? chosenPg.filter((x) => x !== m.name) : [...chosenPg, m.name])} />
              })}
              <NewMachineTile api={api} t={t} />
            </div>
          </Group>
          {machines.length === 0 ? <p className={css.notice}>{t('noMachines')}</p> : null}
          {stoppedPicked(chosen, machines).map((m) => <p key={m} className={css.note}>{t('startsOnCreate', { machine: m })}</p>)}
          {moving ? <p className={css.warn}>{t('moveWarn', { store: existing!.name, machine: chosenSqlite, n: Math.max(0, existing!.projects.length) })}</p> : null}
          </div>
        </section>
      </fieldset>
    </div>
    <footer className={css.foot}>
      <span className={css.footNote}>{firstMissing !== undefined && !running ? t('missing', { part: railTitles[firstMissing], what: summaries[firstMissing] }) : null}</span>
      <div className={css.footActions}>
        <Button type="button" variant="outline" disabled={running} onClick={() => projectDialog.close()}>{t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={running || !data} aria-busy={running} icon={running ? <StateDot state="ongoing" size={13} /> : undefined}>
          {running ? t('creating') : importing ? t('import') : t('create')}
        </Button>
      </div>
    </footer>
  </form>
}

// ---------- configure ----------

/** Configure: the Store, where it runs (move, or attach / detach), and Hide from sidebar. */
function Configure({ api, t, project, back, onBusy }: { api: LayerfsApi, t: SetupT, project: ProjectRef, back?: DialogRequest | undefined, onBusy: (busy: boolean) => void }): ReactNode {
  const view = useStorage(api)
  const [target, setTarget] = useState<string | null>(null)
  const [busy, setBusyState] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)
  const name = project.name ?? project.key.split('/')[1] ?? project.key
  const storeName = project.store ?? project.key.split('/')[0] ?? ''
  const store: StoreRow | undefined = view.data?.stores.find((s) => s.name === storeName)
  const setBusy = (value: string | null) => { setBusyState(value); onBusy(!!value) }
  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label); setError(null)
    try { await work(); setTarget(null) } catch (e) { setError(messageOf(e)) } finally { setBusy(null); view.reload() }
  }
  const head = <Head title={name} sub={<span className={css.mono}>{project.key}</span>} t={t} back={busy ? undefined : back} />
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
  const state = (n: string) => view.data!.machines.find((m) => m.name === n)
  const ensure = async (n: string) => { if (!isRunning(state(n))) await startMachine(api, n) }
  const kindWords = pg ? t('kindPg') : t('kindSqlite')
  const storeCard = <Group label={t('store')}>
    <div className={css.storeCard}>
      <span className={css.kindMark}><StoreKindGlyph kind={store.kind} size={20} /></span>
      <span className={css.kindText}>
        <span className={css.kindName}>{store.name}</span>
        <span className={css.kindBlurb}>{[kindWords, pg ? store.postgresql?.target : null, others === 1 ? t('sharedOne') : others ? t('shared', { n: others }) : t('alone')].filter(Boolean).join(' · ')}</span>
      </span>
    </div>
  </Group>

  if (!pg) {
    const current = store.machine ?? 'native'
    const chosen = target ?? current
    return <>{head}
      <div className={css.body}><div className={css.fields}>
        {storeCard}
        <Group label={t('runsOn')} hint={t('runsOnOne')}>
          <div className={css.machines} role="radiogroup" aria-label={t('runsOn')}>
            {machines.map((m) => <MachineTile key={m.name} m={m} multi={false} selected={chosen === m.name} disabled={!!busy}
              note={machineNote(m, t)} badge={m.name === current ? t('here') : null} onSelect={() => setTarget(m.name)} />)}
            <NewMachineTile api={api} t={t} />
          </div>
        </Group>
        {chosen !== current ? <p className={css.warn}>{t('moveWarn', { store: store.name, machine: chosen, n: others })}</p> : null}
        {chosen !== current ? stoppedPicked([chosen], machines).map((m) => <p key={m} className={css.note}>{t('startsOnMove', { machine: m })}</p>) : null}
        {error ? <p className={css.error} role="alert">{error}</p> : null}
      </div></div>
      <footer className={css.foot}>
        {hide}
        <div className={css.footActions}>
          {chosen !== current
            ? <>
              <Button variant="outline" disabled={!!busy} onClick={() => setTarget(null)}>{t('cancel')}</Button>
              <Button variant="primary" disabled={!!busy} icon={busy ? <StateDot state="ongoing" size={13} /> : undefined}
                onClick={() => void run('move', async () => { if (current !== 'native') await ensure(current); await ensure(chosen); await placeStore(api, store.name, chosen) })}>
                {busy ? t('moving') : t('moveTo', { machine: chosen })}
              </Button>
            </>
            : <Button variant="primary" onClick={() => projectDialog.close()}>{t('done')}</Button>}
        </div>
      </footer>
    </>
  }
  const attached = new Map((store.attachments ?? [{ machine: 'native', checked: null } as { machine: string, checked: boolean | null }]).map((a) => [a.machine, a]))
  return <>{head}
    <div className={css.body}><div className={css.fields}>
      {storeCard}
      <Group label={t('runsOn')} hint={t('attachNote', { store: store.name })}>
        <div className={css.machines} role="group" aria-label={t('runsOn')}>
          {machines.map((m) => {
            const a = attached.get(m.name)
            const note = busy === m.name ? t('working') : a ? (a.checked ? t('attachedChecked') : t('attachedUnchecked')) : t('notAttached')
            return <MachineTile key={m.name} m={m} multi selected={!!a} disabled={!!busy} working={busy === m.name} note={note}
              onSelect={() => void run(m.name, async () => { if (!a) { await ensure(m.name); await attachStore(api, store.name, m.name) } else await detachStore(api, store.name, m.name) })} />
          })}
          <NewMachineTile api={api} t={t} />
        </div>
      </Group>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
    </div></div>
    <footer className={css.foot}>
      {hide}
      <div className={css.footActions}><Button variant="primary" disabled={!!busy} onClick={() => projectDialog.close()}>{t('done')}</Button></div>
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
      ? <Button variant="outline" size="sm" disabled={busy} aria-label={t('startFor', { machine: availability.machine ?? '', project: name })}
        onClick={() => void go(() => api.call('POST', `/api/machines/${enc(availability.machine!)}/start`), (m) => t('startFailed', { machine: availability.machine ?? '', message: m }), false)}>{t('start')}</Button>
      : null}
    <Button variant="ghost" size="sm" className={css.pickGear} icon={<IconSettingsOutlineRegular size={15} />} aria-label={t('configure', { project: name })} title={t('configure', { project: name })} onClick={configure} />
    {error ? <p className={css.pickError} role="alert">{error}</p> : null}
  </li>
}
