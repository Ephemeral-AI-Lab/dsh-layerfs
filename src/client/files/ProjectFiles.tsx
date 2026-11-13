/**
 * A project's saved files: a Branch selector, the folder tree (folders read as
 * they open), the open files as tabs, and the selected file read-only. Shared
 * by Storage's project page and the per-session LayerFS panel.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  FileTypeIcon, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconFolderCloseRegular, IconFolderOpenOutlineRegular,
  IconLinkOutlineRegular, IconSearchOutlineRegular, Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { filesApi } from './api.ts'
import { BranchPicker } from './BranchPicker.tsx'
import { FileViewer, type FileMode } from './FileViewer.tsx'
import { bytes, shortId } from './format.ts'
import { EmptyState, ErrorState, Loading } from './States.tsx'
import type { BranchInfo, FsEntry, Translate } from './types.ts'
import { useQuery } from './use-query.ts'
import css from './Files.module.css'

export interface ProjectFilesProps {
  api: LayerfsApi
  /** The project key, `<store>/<project>`. */
  project: string
  t: Translate
  /** The Branch to open on (default main). */
  initialBranch?: string | undefined
  /** A saved id to browse instead of the Branch's head. */
  initialPin?: string | undefined
  /** A file to open first. */
  initialPath?: string | undefined
  /** Changes when the project may have changed: open folders and files read again. */
  tick?: number | undefined
  /** Tells the caller which Branch is shown. */
  onBranchChange?: ((branch: string) => void) | undefined
  className?: string | undefined
}

export function ProjectFiles(props: ProjectFilesProps): ReactNode {
  const { api, project, t } = props
  const [pos, setPos] = useState(0)
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const query = useQuery(() => filesApi.branches(api, project, pos), [api, project, pos], { refresh: [props.tick], cache: `branches:${project}:${pos}` })
  useEffect(() => {
    if (query.data) setBranches((all) => [...new Map([...(pos ? all : []), ...query.data!.items].map((b) => [b.name, b])).values()])
  }, [query.data, pos])
  if (query.error && !query.data) return <ErrorState title={t('files_readFailed', { what: project })} error={query.error} retryLabel={t('files_retry')} onRetry={query.reload} />
  // Progressive: with a Branch to open, its folder tree loads at once (at its tip) while the
  // Branch list is still on its way; the list fills the picker when it arrives.
  if (!query.data && !props.initialBranch) return <Loading label={t('files_readingFiles')} className={css.pad} />
  const shown = query.data ? branches : [provisional(props.initialBranch!)]
  if (!shown.length) return <EmptyState title={t('files_noBranches')}>{t('files_noBranchesBody')}</EmptyState>
  return (
    <FilesFrame key={project} {...props} branches={shown}
      more={query.data?.next != null ? () => setPos(query.data!.next!) : undefined} />
  )
}

/** A Branch known only by name until the Branch list arrives (read at its tip). */
const provisional = (name: string): BranchInfo => ({ name, head: null, parent: null, forkedFrom: null, state: 'open', commits: null })

/** Browse one exact saved version without exposing internal branch controls. */
export function SavedProjectFiles(props: Pick<ProjectFilesProps, 'api' | 'project' | 't'> & { version: string }): ReactNode {
  const branches: BranchInfo[] = [{ name: 'main', head: props.version, parent: null, forkedFrom: null, state: 'open', commits: null }]
  return <FilesFrame key={`${props.project}:${props.version}`} {...props} initialBranch="main" initialPin={props.version} branches={branches} more={undefined} savedOnly />
}

/** A folder's entries, its read in progress, or its refusal. */
type Dir = FsEntry[] | 'loading' | Error

const byKind = (a: FsEntry, b: FsEntry) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

function FilesFrame({ api, project, t, branches, initialBranch, initialPin, initialPath, tick = 0, onBranchChange, className, more, savedOnly = false }: ProjectFilesProps & { branches: BranchInfo[], more: (() => void) | undefined, savedOnly?: boolean }) {
  const [ref, setRef] = useState(() => (initialBranch && branches.some((b) => b.name === initialBranch) ? initialBranch : branches.find((b) => b.name === 'main')?.name ?? branches[0]!.name))
  const [pin, setPin] = useState<string | undefined>(initialPin)
  const head = branches.find((b) => b.name === ref)?.head ?? undefined
  const at = pin ?? head
  const [dirs, setDirs] = useState<Map<string, Dir>>(new Map())
  const [nexts, setNexts] = useState<Record<string, number | null>>({})
  const [open, setOpen] = useState<Set<string>>(() => new Set(initialPath ? parentsOf(initialPath) : []))
  const [tabs, setTabs] = useState<string[]>(initialPath ? [initialPath] : [])
  const [active, setActive] = useState<string | undefined>(initialPath)
  const [query, setQuery] = useState('')
  // Code, Blame or History stays chosen across files.
  const [mode, setMode] = useState<FileMode>('code')
  const generation = useRef(0)
  const openRef = useRef(open)
  openRef.current = open

  const load = useCallback((path: string, pos = 0, quiet = false) => {
    const version = generation.current
    if (!pos && !quiet) setDirs((all) => new Map(all).set(path, 'loading'))
    filesApi.list(api, project, ref, path, at, pos).then(
      (page) => {
        if (version !== generation.current) return
        setNexts((m) => ({ ...m, [path]: page.next }))
        setDirs((all) => {
          const had = all.get(path)
          return new Map(all).set(path, pos && Array.isArray(had) ? [...had, ...page.items] : page.items)
        })
      },
      (e: unknown) => {
        if (version !== generation.current) return
        // A quiet reread that fails keeps the folder it had.
        setDirs((all) => quiet && Array.isArray(all.get(path)) ? all : new Map(all).set(path, e instanceof Error ? e : new Error(String(e))))
      },
    )
  }, [api, project, ref, at])

  // Another Branch or pinned version starts the tree over. The Branch's head moving (new
  // saves) or a refresh rereads the open folders in place, keeping what is on screen.
  const shown = useRef<string | null>(null)
  useEffect(() => {
    generation.current++
    const same = shown.current === `${ref}\u0000${pin ?? ''}`
    shown.current = `${ref}\u0000${pin ?? ''}`
    if (!same) setDirs(new Map())
    for (const path of ['/', ...openRef.current]) load(path, 0, same)
    return () => { generation.current++ }
  }, [load])
  const firstTick = useRef(tick)
  useEffect(() => {
    if (tick === firstTick.current) return
    for (const path of ['/', ...openRef.current]) load(path, 0, true)
  }, [tick])

  const root = dirs.get('/')
  const greeted = useRef(false)
  useEffect(() => {
    if (greeted.current || !Array.isArray(root)) return
    greeted.current = true
    const readme = root.find((e) => e.kind === 'file' && /^readme(\.md|\.txt)?$/i.test(e.name))
    if (readme && tabs.length === 0) { setTabs([readme.path]); setActive(readme.path) }
  }, [root, tabs.length])

  const toggle = (path: string) => {
    const next = new Set(open)
    if (next.has(path)) next.delete(path)
    else { next.add(path); if (!Array.isArray(dirs.get(path))) load(path) }
    setOpen(next)
  }
  const openFile = (entry: FsEntry) => {
    setTabs((all) => (all.includes(entry.path) ? all : [...all, entry.path]))
    setActive(entry.path)
  }
  const closeFile = (path: string) => {
    const next = tabs.filter((p) => p !== path)
    setTabs(next)
    if (active === path) setActive(next.at(-1))
  }
  const choose = (name: string) => { setRef(name); setPin(undefined); onBranchChange?.(name) }

  const q = query.trim().toLowerCase()
  const loaded = [...dirs.values()].flatMap((d) => (Array.isArray(d) ? d : []))
  const matches = q ? loaded.filter((n) => n.kind !== 'dir' && n.path.toLowerCase().includes(q)).slice(0, 200) : []

  return (
    <div className={clsx(css.frameWrap, className)}><div className={css.frame}>
      <aside className={css.side} aria-label={t('files_tree')}>
        <div className={css.sideHead}>
          {!savedOnly ? <BranchPicker branches={branches} value={ref} onChange={choose} t={t} /> : null}
          {more ? <button type="button" className={css.linkButton} onClick={more}>{t('files_moreBranches')}</button> : null}
          <p className={css.savedAt} title={at}>
            {t('files_saved', { id: shortId(at) })}
            {!savedOnly && pin && pin !== head ? <> · <button type="button" className={css.inlineLink} onClick={() => setPin(undefined)}>{t('files_latest')}</button></> : null}
          </p>
          <Input className={css.find} icon={<IconSearchOutlineRegular size={14} />} placeholder={t('files_findPlaceholder')} aria-label={t('files_findPlaceholder')}
            value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery('') } }} />
        </div>
        <div className={css.treeScroll}>
          {q ? (
            matches.length === 0 ? <p className={css.treeNote}>{t('files_noMatch')}</p> : (
              <ul className={css.tree} aria-label={t('files_tree')}>
                {matches.map((n) => (
                  <li key={n.path}>
                    <button type="button" className={css.treeRow} data-active={n.path === active || undefined} onClick={() => openFile(n)} title={n.path}>
                      <span className={css.treeIcon}><FileTypeIcon path={n.name} size={16} /></span>
                      <span className={css.treePath}>{n.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <Tree path="/" depth={0} dirs={dirs} open={open} nexts={nexts} selected={active} onToggle={toggle} onOpenFile={openFile} onMore={load} t={t} />
          )}
        </div>
      </aside>
      <section className={css.main}>
        <div className={css.tabs} role="tablist" aria-label={t('files_openFiles')}>
          {tabs.map((p) => {
            const name = p.split('/').pop() || p
            const on = p === active
            return (
              <div key={p} role="tab" aria-selected={on} className={css.tab} data-active={on || undefined}>
                <button type="button" className={css.tabOpen} title={p} onClick={() => setActive(p)}>
                  <FileTypeIcon path={name} size={14} />
                  <span>{name}</span>
                </button>
                <button type="button" className={css.tabClose} aria-label={t('files_close', { name: p })} onClick={() => closeFile(p)}>
                  <IconCloseOutlineRegular size={12} />
                </button>
              </div>
            )
          })}
          {tabs.length === 0 ? <span className={css.tabsNote}>{t('files_readOnly')}</span> : null}
        </div>
        <div className={css.viewer}>
          {active
            ? <FileViewer key={`${ref}:${active}:${at}`} api={api} project={project} branch={ref} path={active} pin={at} t={t} mode={mode} onModeChange={setMode} />
            : <EmptyState title={t('files_openFromTree')} icon={<FileTypeIcon kind="other" size={20} />}>{t('files_openFromTreeBody')}</EmptyState>}
        </div>
      </section>
    </div></div>
  )
}

const parentsOf = (path: string): string[] => {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, -1).map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)
}

interface TreeProps {
  path: string
  depth: number
  dirs: Map<string, Dir>
  open: Set<string>
  nexts: Record<string, number | null>
  selected: string | undefined
  onToggle: (path: string) => void
  onOpenFile: (entry: FsEntry) => void
  onMore: (path: string, pos: number) => void
  t: Translate
}

function Tree({ path, depth, dirs, open, nexts, selected, onToggle, onOpenFile, onMore, t }: TreeProps): ReactNode {
  const dir = dirs.get(path)
  const indent = { '--files-depth': depth } as CSSProperties
  if (dir === undefined || dir === 'loading') return <p className={css.treeNote} style={indent}>{t('files_reading')}</p>
  if (dir instanceof Error) return <p className={clsx(css.treeNote, css.treeError)} style={indent} title={dir.message}>{t('files_folderFailed')}</p>
  if (dir.length === 0) return <p className={css.treeNote} style={indent}>{t('files_emptyFolder')}</p>
  const next = nexts[path]
  return (
    <ul className={css.tree} role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? t('files_tree') : undefined}>
      {[...dir].sort(byKind).map((n) => {
        const expanded = open.has(n.path)
        const isDir = n.kind === 'dir'
        return (
          <li key={n.path} role="treeitem" aria-expanded={isDir ? expanded : undefined} aria-selected={n.path === selected}>
            <button type="button" className={css.treeRow} style={indent} data-active={n.path === selected || undefined}
              title={isDir ? n.path : `${n.path} · ${bytes(n.size)}`} onClick={() => (isDir ? onToggle(n.path) : onOpenFile(n))}>
              {isDir
                ? <IconChevronRightOutlineRegular size={12} className={clsx(css.chevron, expanded && css.chevronOpen)} />
                : <span className={css.chevronSpace} />}
              <span className={css.treeIcon}>
                {isDir ? (expanded ? <IconFolderOpenOutlineRegular size={16} /> : <IconFolderCloseRegular size={16} />)
                  : n.kind === 'symlink' ? <IconLinkOutlineRegular size={14} /> : <FileTypeIcon path={n.name} size={16} />}
              </span>
              <span className={css.treeName}>{n.name}</span>
            </button>
            {isDir && expanded ? <Tree {...{ dirs, open, nexts, selected, onToggle, onOpenFile, onMore, t }} path={n.path} depth={depth + 1} /> : null}
          </li>
        )
      })}
      {next != null ? <li><button type="button" className={css.linkButton} style={indent} onClick={() => onMore(path, next)}>{t('files_moreEntries')}</button></li> : null}
    </ul>
  )
}

