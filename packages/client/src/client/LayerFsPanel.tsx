// The LayerFS sidebar page: one project at a time, like an editor. A slim
// title bar has two tabs, three while the LayerFS scripted model is on, each
// with an icon:
// Tests (ScenariosPage: the scripted model's scenarios, run on LayerFS), All projects (AllSandboxes: every
// project's Sandboxes and what they run on; a project's card opens it, and
// Import project opens a folder chooser and imports the folder, bound to no workspace, InitDialog) and the open
// project. Then the project's one action, New session (in
// a workspace picked from its menu, which then uses the project by default),
// and a menu for Refresh and Remove (RemoveDialog). The project (ProjectBoard)
// fills the rest: Files' tree in a sidebar, File, History, Storage and
// Sandboxes tabs,
// and a status bar with where main is, Branches, Commits, the last publish
// and the Store's size. ellen_joe shows full size where there is nothing else.
// Colours, borders and radii are dsh's own tokens (--dsw-*, tokens.ts), which
// the sharky maid theme (maid.tsx) sets inside the page.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  Button,
  IconChecklistOutlineRegular,
  IconEllipsisOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
  IconTrashOutlineRegular,
  IconFlatListOutlineRegular,
  Menu,
  type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import ellen from '../../../../sim/avatars/ellen_joe.gif'
import { AllSandboxes } from './AllSandboxes.tsx'
import { api, readProject, type Project, type ProjectState, type Status, type Storage } from './api.ts'
import { InitDialog } from './InitDialog.tsx'
import { MAID_CSS } from './maid.tsx'
import { ProjectBoard } from './ProjectBoard.tsx'
import { RemoveDialog } from './RemoveDialog.tsx'
import { ScenariosPage } from './ScenariosPage.tsx'
import { mockApi, type RunServices } from './scenarios.ts'
import { followTheme } from './theme.ts'
import { card, T } from './tokens.ts'

/** What the panel uses of dsh's workspace services (read with ctx.get). */
export interface PanelServices {
  workspaces?: { list: { getSnapshot(): { items: readonly Workspace[] }; subscribe(listener: () => void): () => void } }
  uiWorkspace?: {
    startSession(workspaceId?: string, options?: { agentPreset?: string }): void
    listDirectory(path?: string): Promise<any>
    openSession?(sessionId: string): void
  }
  /** what a scenario run uses of dsh's services, for the Tests tab */
  runs?: RunServices
}
interface Workspace {
  workspaceId: string
  path: string
  title: string
}

const PRESET = 'layerfs-dsh-minimalist'
const NO_ITEMS = { items: [] as readonly Workspace[] }
const NOT_LISTED = { getSnapshot: () => NO_ITEMS, subscribe: () => () => {} }

const ROWS = `.lfs-switch, .lfs-chip { background: transparent; cursor: pointer; } .lfs-switch:hover, .lfs-switch[aria-expanded='true'], .lfs-chip:hover, .lfs-chip[aria-expanded='true'] { background: ${T.hover}; }
.lfs-card:hover { box-shadow: inset 0 0 0 999px ${T.hover}; }
.lfs-bone { border-radius: 4px; background: ${T.well}; animation: lfs-bone 1.2s ease-in-out infinite alternate; } @keyframes lfs-bone { to { opacity: .45; } }`

/** The LayerFS mark (docs/assets/readme/layerfs-mark.svg) in the text colour: the A at 45%, its three nodes solid. */
export function LayerFsIcon({ size }: { size?: number }) {
  const s = size ?? 16
  return (
    <svg width={s} height={s} viewBox="6 6 188 188" fill="none" aria-hidden="true">
      <path
        d="M88.5 22 L111.5 22 L170 135 L148.5 135 L100 49.5 L51.5 135 L30 135 Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        opacity="0.45"
      />
      <path
        d="M27 161 L57 161 L100 117 L143 161 L173 161"
        stroke="currentColor"
        strokeWidth="12"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="100" cy="117" r="17" fill="currentColor" />
      <circle cx="27" cy="161" r="17" fill="currentColor" />
      <circle cx="173" cy="161" r="17" fill="currentColor" />
    </svg>
  )
}

/** One tab of the title bar: an icon and a label; `shrink` lets a long label (a project's name) ellipsize. */
function Tab({
  on,
  onClick,
  icon,
  title,
  shrink,
  children,
}: {
  on: boolean
  onClick: () => void
  icon: React.ReactNode
  title: string
  shrink?: true
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      className="lfs-switch lfs-tab"
      onClick={onClick}
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flex: shrink ? '0 1 auto' : 'none',
        minWidth: 0,
        maxWidth: shrink ? 320 : undefined,
        padding: '0 10px',
        border: 0,
        color: 'inherit',
        font: 'inherit',
        fontSize: 14,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      <span className="lfs-tab-icon" style={{ display: 'flex', flex: 'none' }}>
        {icon}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{children}</span>
    </button>
  )
}

const short = (path: string) => path.split('/').filter(Boolean).slice(-2).join('/')
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/** One fact on the status bar: a count reads "8 Commits", a place "main L1". */
interface Fact {
  label: string
  value?: string
  title?: string
  count?: true
}

/** The project's status bar. */
function stats(state: ProjectState): Fact[] {
  const s = state.s,
    real = Object.fromEntries(Object.entries(state.labels).map(([r, l]) => [l, r]))
  const last = Object.values(s.layers as Record<string, any>)
    .filter((l) => l.sourceBranch)
    .sort((a, b) => b.slot - a.slot)[0]
  const by = last && state.authors[real[last.id]]
  const nB = s.branchOrder.length,
    nC = Object.keys(s.commits).length
  return [
    { label: 'main', value: s.main?.head ?? '–' },
    { label: nB === 1 ? 'Branch' : 'Branches', value: String(nB), count: true },
    { label: nC === 1 ? 'Commit' : 'Commits', value: String(nC), count: true },
    {
      label: 'last publish',
      value: last ? `${last.sourceBranch}${by ? ` · ${by}` : ''}` : 'nothing yet',
      title: last ? `${last.sourceBranch} published as ${last.id}${by ? ` by ${by}` : ''}` : undefined,
    },
  ]
}

function FactView({ f }: { f: Fact }) {
  const v = <span style={{ fontWeight: 500, color: f.value ? T.text : T.caption }}>{f.value ?? '…'}</span>,
    l = <span style={{ color: T.text2 }}>{f.label}</span>
  return (
    <span
      title={f.title}
      style={{
        display: 'inline-flex',
        gap: 4,
        whiteSpace: 'nowrap',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {f.count ? (
        <>
          {v}
          {l}
        </>
      ) : (
        <>
          {l}
          {v}
        </>
      )}
    </span>
  )
}

/**
 * Why the project could not be read, in words: a title, what happened and
 * what to do, and whether removing and importing it again is the way out.
 */
function problem(error: string): { title: string; text: string; reimport?: true } {
  // the SDK refuses a second client while one is starting the project's Sandbox
  if (/^Busy\b/.test(error))
    return {
      title: 'LayerFS is busy with this project',
      text: 'Another client is starting its Sandbox. Refresh in a moment.',
    }
  // a start that failed earlier left its record, and the SDK will not guess how it ended
  if (/unresolved discovery intent/.test(error))
    return {
      title: 'An earlier start of this project failed',
      reimport: true,
      text: "LayerFS kept a record of that failed start and won't start the project again until it's cleared. This usually means the project was imported by an older LayerFS, which this one can't open. Remove the project and import its folder again: its saved history goes, the folder's files stay.",
    }
  // the daemon exited before it listened: it refused the Store
  if (/stopped at Listener/.test(error))
    return {
      title: "LayerFS couldn't open this project",
      reimport: true,
      text: "Its daemon stopped before it was ready. This usually means the project was imported by an older LayerFS, which this one can't open. Remove the project and import its folder again: its saved history goes, the folder's files stay.",
    }
  return { title: "Couldn't read this project", text: error }
}

/** ellen_joe at full size, for a page with nothing else to show. */
function Notice({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 16, padding: 16 }}>
      <img src={ellen} alt="" width={72} height={72} style={{ flex: 'none' }} />
      <div style={{ display: 'grid', gap: 4 }}>
        <div style={{ fontWeight: 500 }}>{title}</div>
        {children && <div style={{ color: T.text2 }}>{children}</div>}
      </div>
    </div>
  )
}

/** The board's shape while the project is read: a file tree on the left, the tabs and History on the right. */
function Skeleton() {
  const bars = (widths: number[]) =>
    widths.map((w, i) => <div key={i} className="lfs-bone" style={{ height: 12, width: `${w}%` }} />)
  return (
    <div
      aria-label="Reading the project"
      style={{
        ...card,
        flex: 1,
        minHeight: 440,
        display: 'grid',
        gridTemplateColumns: '248px minmax(0, 1fr)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{ display: 'grid', alignContent: 'start', gap: 14, padding: 16, borderRight: `1px solid ${T.border}` }}
      >
        {bars([90, 50, 65, 45, 70, 40, 55])}
      </div>
      <div style={{ display: 'grid', alignContent: 'start', gap: 16, padding: 16 }}>
        {bars([30, 70, 45, 80, 55, 65])}
      </div>
    </div>
  )
}

export function LayerFsPanel({ services }: { services: () => PanelServices }) {
  const { workspaces, uiWorkspace } = services()
  const list = workspaces?.list ?? NOT_LISTED
  const subscribe = useCallback((listener: () => void) => list.subscribe(listener), [list])
  const { items } = useSyncExternalStore(subscribe, () => list.getSnapshot())
  const [status, setStatus] = useState<Status | null>(null)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [defaults, setDefaults] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [state, setState] = useState<ProjectState | null>(null)
  const [stateError, setStateError] = useState<string | null>(null)
  const [storage, setStorage] = useState<Storage | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => followTheme(root.current!), [])
  const [error, setError] = useState<string | null>(null)
  const [reads, setReads] = useState(0)
  // Import project's Init dialog: a folder chosen in it, bound to no workspace
  const [importing, setImporting] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [menu, setMenu] = useState<'project' | 'import' | 'session' | null>(null)
  // the All projects page instead of a project, and the tab a project opens with when one of its cards was clicked
  const [all, setAll] = useState(false)
  const [openTab, setOpenTab] = useState<'sandboxes' | undefined>(undefined)
  // the Tests page instead of any, and whether the scripted model is on (its route answers)
  const [scenariosTab, setScenariosTab] = useState(false)
  const [scripted, setScripted] = useState(false)
  useEffect(() => {
    mockApi.info().then(
      (i) => setScripted(i !== null),
      () => setScripted(false),
    )
  }, [])
  // a page beside the projects: Tests
  const aside = scripted && scenariosTab
  const show = (page: 'all' | 'project' | 'scenarios') => {
    setAll(page === 'all')
    setScenariosTab(page === 'scenarios')
  }

  const loadProjects = useCallback(
    () =>
      api.projects().then(({ projects, defaults }) => {
        setProjects(projects)
        setDefaults(defaults ?? {})
        return projects
      }),
    [],
  )
  useEffect(() => {
    api.status().then(setStatus, (e: Error) => setError(e.message))
    loadProjects().then(
      (list) => setSelected((current) => current ?? list[0]?.name ?? null),
      (e: Error) => setError(e.message),
    )
  }, [loadProjects])
  useEffect(() => {
    if (!selected) return
    setState(null)
    setStateError(null)
    setStorage(null)
    setStorageError(null)
    // the Store's figures, read once alongside History (again on Refresh): the board
    // remounts while the project loads, so they are kept here
    let stopped = false
    api.projectStorage(selected).then(
      (z) => {
        if (!stopped) setStorage(z)
      },
      (e: Error) => {
        if (!stopped) setStorageError(e.message)
      },
    )
    // History draws as soon as the Store answers; Workspaces follow with the full state
    const stop = readProject(selected, setState, setStateError)
    return () => {
      stopped = true
      stop()
    }
  }, [selected, reads])

  const act = (label: string, run: () => Promise<unknown>) => async () => {
    setBusy(label)
    setError(null)
    try {
      await run()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const project = projects?.find((p) => p.name === selected) ?? null
  // a new session in a workspace: the project becomes that folder's default, which the session then uses
  const newSession = (w: Workspace) =>
    act('Opening a session…', async () => {
      await api.setDefault(w.path, project!.name)
      await loadProjects()
      uiWorkspace!.startSession(w.workspaceId, { agentPreset: PRESET })
    })()
  // workspaces where the project is already the default first
  const sessionMenu: MenuEntry[] = [
    { type: 'label', id: 'l', text: 'New session in' },
    ...[...items]
      .sort((a, b) => Number(defaults[b.path] === project?.name) - Number(defaults[a.path] === project?.name))
      .map((w) => ({
        id: w.workspaceId,
        label: `${w.title} · ${short(w.path)}${defaults[w.path] === project?.name ? ' · default' : ''}`,
      })),
  ]

  // the project menu: Refresh, Remove
  const projectMenu: MenuEntry[] = project
    ? [
        { id: 'refresh', label: 'Refresh', icon: <IconRefreshOutlineRegular size={16} /> },
        { type: 'separator', id: 'sep' },
        { id: 'remove', label: 'Remove project…', icon: <IconTrashOutlineRegular size={16} />, danger: true },
      ]
    : []
  const onProjectMenu = (id: string) => {
    setMenu(null)
    if (id === 'refresh') setReads((n) => n + 1)
    else if (id === 'remove') setRemoving(true)
  }
  // Import project: projects belong to no workspace here, so it opens the folder chooser directly
  const importButton = () => (
    <Button
      variant="outline"
      size="sm"
      icon={<IconPlusOutlineRegular size={16} />}
      disabled={!status?.configured}
      onClick={() => setImporting(true)}
    >
      Import project
    </Button>
  )

  return (
    <div
      ref={root}
      className="lfs-maid"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        fontSize: 13,
        lineHeight: '20px',
        color: T.text,
      }}
    >
      <style>{ROWS + MAID_CSS}</style>
      <main
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflowY: 'auto',
          padding: '12px 16px 16px',
        }}
      >
        {status && !status.configured && (
          <div style={{ ...card, padding: '8px 12px', color: T.warn }}>
            LayerFS isn't set up: layerfs-host is missing {status.missing.join(', ')}.
          </div>
        )}
        {!all && !aside && projects && projects.length === 0 && (
          <Notice title="Start your first project">
            <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
              <span>Import a folder: LayerFS keeps a versioned copy that agents fork, test and merge.</span>
              {importButton()}
            </div>
          </Notice>
        )}
        {(all || project || aside || projects?.length === 0) && (
          <>
            <header
              className="lfs-head"
              style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, minHeight: 40 }}
            >
              <span className="lfs-mark" style={{ display: 'flex', flex: 'none', color: T.text2, marginRight: 4 }}>
                <LayerFsIcon size={20} />
              </span>
              <span
                role="tablist"
                aria-label="LayerFS"
                style={{ display: 'flex', alignItems: 'stretch', alignSelf: 'stretch', gap: 2, minWidth: 0 }}
              >
                <Tab
                  on={!aside && (all || !project)}
                  onClick={() => show('all')}
                  icon={<IconFlatListOutlineRegular size={16} />}
                  title="Every project and its Sandboxes; a card opens a project"
                >
                  All projects
                </Tab>
                {project && (
                  <Tab
                    on={!all && !aside}
                    onClick={() => show('project')}
                    icon={<IconFolderOpenOutlineRegular size={16} />}
                    title={project.name}
                    shrink
                  >
                    {project.name}
                  </Tab>
                )}
                {scripted && (
                  <Tab
                    on={scenariosTab}
                    onClick={() => show('scenarios')}
                    icon={<IconChecklistOutlineRegular size={16} />}
                    title="The LayerFS scripted model's tests, each run on LayerFS"
                  >
                    Tests
                  </Tab>
                )}
              </span>
              {aside && <span style={{ flex: 1 }} />}
              {!aside && (all || (!project && projects?.length !== 0)) && (
                <>
                  <span style={{ flex: 1 }} />
                  {importButton()}
                </>
              )}
              {!all && !aside && project && (
                <>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12,
                      color: T.text2,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={`${project.empty ? 'started empty' : project.source} · volume ${project.volume}`}
                  >
                    {project.empty ? 'started empty' : `from ${short(project.source)}`} · {day(project.created)}
                  </span>
                  <Menu
                    open={menu === 'session'}
                    onClose={() => setMenu(null)}
                    items={sessionMenu}
                    align="end"
                    portal
                    onSelect={(id) => {
                      setMenu(null)
                      const w = items.find((x) => x.workspaceId === id)
                      if (w) void newSession(w)
                    }}
                    anchor={
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={!!busy || !items.length || !uiWorkspace}
                        onClick={() => setMenu(menu === 'session' ? null : 'session')}
                        title={
                          items.length
                            ? 'New session on the LayerFS × DSH minimalist preset, in a workspace you pick'
                            : 'Add a workspace in dsh first'
                        }
                      >
                        New session
                      </Button>
                    }
                  />
                  <Menu
                    open={menu === 'project'}
                    onClose={() => setMenu(null)}
                    items={projectMenu}
                    onSelect={onProjectMenu}
                    align="end"
                    portal
                    anchor={
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Project actions"
                        icon={<IconEllipsisOutlineRegular size={16} />}
                        disabled={!!busy}
                        onClick={() => setMenu(menu === 'project' ? null : 'project')}
                      />
                    }
                  />
                </>
              )}
            </header>
            {(busy || error) && (
              <div role="status" style={{ color: error ? T.danger : T.text2 }}>
                {error ?? busy}
              </div>
            )}
            {aside ? (
              <ScenariosPage services={() => services().runs ?? {}} />
            ) : all || !project ? (
              <AllSandboxes
                onOpen={(name) => {
                  setOpenTab('sandboxes')
                  setSelected(name)
                  setAll(false)
                }}
              />
            ) : stateError ? (
              (() => {
                const why = problem(stateError)
                return (
                  <Notice title={why.title}>
                    <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
                      <span>{why.text}</span>
                      {why.reimport && (
                        <Button
                          variant="outline"
                          size="sm"
                          icon={<IconTrashOutlineRegular size={16} />}
                          disabled={!!busy}
                          onClick={() => setRemoving(true)}
                        >
                          Remove project…
                        </Button>
                      )}
                      {why.text !== stateError && (
                        <details style={{ fontSize: 12, color: T.caption }}>
                          <summary style={{ cursor: 'pointer' }}>What LayerFS said</summary>
                          <div style={{ marginTop: 4, wordBreak: 'break-word' }}>{stateError}</div>
                        </details>
                      )}
                    </div>
                  </Notice>
                )
              })()
            ) : state ? (
              <ProjectBoard
                name={project.name}
                state={state}
                storage={storage}
                storageError={storageError}
                tab={openTab}
                status={stats(state).map((f) => <FactView key={f.label} f={f} />)}
              />
            ) : (
              <Skeleton />
            )}
          </>
        )}
      </main>
      {removing && project && (
        <RemoveDialog
          project={project}
          onClose={() => setRemoving(false)}
          onDone={() => {
            setRemoving(false)
            void loadProjects().then((list) => setSelected(list[0]?.name ?? null))
          }}
        />
      )}
      {importing && (
        <InitDialog
          folder={null}
          directories={uiWorkspace}
          onClose={() => setImporting(false)}
          onDone={(made) => {
            setImporting(false)
            void loadProjects().then(() => {
              setOpenTab(undefined)
              setSelected(made.name)
              setAll(false)
            })
          }}
        />
      )}
    </div>
  )
}
