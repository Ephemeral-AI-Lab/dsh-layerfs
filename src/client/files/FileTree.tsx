/**
 * A folder tree whose folders are read as they open: the rows, "more entries"
 * paging and a filter over the entries read so far. Shared by the project file
 * view and the machine and Sandbox file views. The caller owns what a folder
 * read asks ({@link useFolders}' `read`), which folders are open, the order of
 * the rows and what opening a row does.
 *
 * Keyboard: the tree is one tab stop. Up and Down move between the rows
 * showing, Home and End go to the first and last, Right opens a folder or
 * steps into an open one, Left closes a folder or steps out to its parent,
 * typing goes to the next row whose name starts with what was typed, and Enter
 * or Space activates the row. A folder being read is `aria-busy`.
 *
 * A view may also say, per row ({@link TreeRow}): that it cannot be activated
 * (`aria-disabled`: an entry that is listed but never opened), another name
 * and a dimmer second text (a root's role and its real path, a link's
 * target), what follows the row outside its button (a chip, a lock, actions)
 * and a line under it; and, per folder, what a read in progress, a refused
 * read and the "more entries" row show ({@link FileTreeProps.pending},
 * `failed`, `more`).
 */
import { useCallback, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import clsx from 'clsx'
import {
  FileTypeIcon, IconChevronRightOutlineRegular, IconFolderCloseRegular, IconFolderOpenOutlineRegular, IconLinkOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { bytes } from './format.ts'
import type { Translate } from './types.ts'
import css from './Files.module.css'

/**
 * What a row is. A view names its own kinds; these are the ones the file views
 * use. Only `dir` opens as a folder unless {@link FileTreeProps.row} says otherwise.
 */
export type TreeKind = 'file' | 'dir' | 'symlink' | 'mount' | 'restricted' | 'system' | 'unreadable' | 'other'

/** One row: an entry of a folder. `path` is its key, and the key its own entries are read under. */
export interface TreeEntry {
  name: string
  path: string
  kind: TreeKind | string
  size?: number | null | undefined
}

/** A folder's entries, its read in progress, or its refusal. */
export type TreeDir<E extends TreeEntry = TreeEntry> = E[] | 'loading' | Error

/** One page of a folder: its entries and where the next page starts (null at the end). */
export interface FolderPage<E extends TreeEntry, C> {
  items: E[]
  next: C | null
}

/** The folders read so far and their reads ({@link useFolders}). */
export interface Folders<E extends TreeEntry, C> {
  dirs: Map<string, TreeDir<E>>
  /** Each read folder's cursor for its next page; null when it has none. */
  nexts: Record<string, C | null>
  /**
   * Read a folder: its first page, or with `cursor` the page there, appended to what it has.
   * @param quiet - a first page that keeps what is on screen until it answers, and when it fails.
   */
  load: (path: string, cursor?: C | null, quiet?: boolean) => void
  /** Drop the answers still on their way; with `clear`, forget every folder read so far too. */
  reset: (clear: boolean) => void
}

/**
 * The folders of one tree, each read on request and page by page.
 * @param read - reads the page of `path` at `cursor` (its first page without one).
 *   A new function is a new `load`: the caller starts over with `reset` and reads again.
 */
export function useFolders<E extends TreeEntry, C>(read: (path: string, cursor?: C) => Promise<FolderPage<E, C>>): Folders<E, C> {
  const [dirs, setDirs] = useState<Map<string, TreeDir<E>>>(new Map())
  const [nexts, setNexts] = useState<Record<string, C | null>>({})
  const generation = useRef(0)

  const load = useCallback((path: string, cursor?: C | null, quiet = false) => {
    const version = generation.current
    // A cursor that is not a page position (0, '') reads the first page, as no cursor does.
    const from = cursor || undefined
    if (from === undefined && !quiet) setDirs((all) => new Map(all).set(path, 'loading'))
    read(path, from).then(
      (page) => {
        if (version !== generation.current) return
        setNexts((m) => ({ ...m, [path]: page.next }))
        setDirs((all) => {
          const had = all.get(path)
          return new Map(all).set(path, from !== undefined && Array.isArray(had) ? [...had, ...page.items] : page.items)
        })
      },
      (e: unknown) => {
        if (version !== generation.current) return
        // A quiet reread that fails keeps the folder it had.
        setDirs((all) => quiet && Array.isArray(all.get(path)) ? all : new Map(all).set(path, e instanceof Error ? e : new Error(String(e))))
      },
    )
  }, [read])

  const reset = useCallback((clear: boolean) => {
    generation.current++
    if (clear) setDirs(new Map())
  }, [])

  return { dirs, nexts, load, reset }
}

/** The tree's words. */
export interface FileTreeLabels {
  /** The tree's accessible name. */
  tree: string
  /** A folder being read. */
  reading: string
  /** A folder that could not be read (its refusal is the note's tooltip). */
  failed: string
  /** A folder without entries. */
  empty: string
  /** The button that reads a folder's next page. */
  more: string
  /** No entry read so far matches the filter. */
  noMatch: string
}

/** The file views' words for a tree (`files_*` keys of the files dictionary). */
export const treeLabels = (t: Translate): FileTreeLabels => ({
  tree: t('files_tree'),
  reading: t('files_reading'),
  failed: t('files_folderFailed'),
  empty: t('files_emptyFolder'),
  more: t('files_moreEntries'),
  noMatch: t('files_noMatch'),
})

/** How one row shows and acts; {@link FileTreeProps.row} overrides any part. */
export interface TreeRow {
  /** Opens as a folder: a chevron, and its entries under it while open. Default: the kind is `dir`. */
  expandable: boolean
  /** The icon before the name. Default: a folder, a link for `symlink`, else the file type by name. */
  icon: ReactNode
  /** The row's tooltip. Default: the path, with a file's size. */
  title: string
  /** The row cannot be activated: listed, reachable by the keys, `aria-disabled`. */
  disabled?: boolean | undefined
  /** The name shown instead of the entry's own (a root's role in words). Type-ahead uses it. */
  label?: string | undefined
  /** Dimmer text after the name: a root's real path, a link's target. */
  secondary?: string | undefined
  /** What follows the row, outside its button: a chip, a lock, actions. */
  trailing?: ReactNode
  /** A line under the row. */
  below?: ReactNode
}

/** What a folder's "more entries" row shows instead of {@link FileTreeLabels.more}. */
export interface TreeMore {
  label: string
  /** Its page is being read: the button does nothing. */
  busy?: boolean | undefined
  /** What follows the button (a refusal, Cancel). */
  note?: ReactNode
}

export interface FileTreeProps<E extends TreeEntry, C> {
  /** The folder the tree starts at (default `/`). */
  root?: string | undefined
  /** The folders read so far, by path ({@link useFolders}). */
  dirs: ReadonlyMap<string, TreeDir<E>>
  /** The open folders. */
  open: ReadonlySet<string>
  /** Each folder's cursor for its next page; a folder with one ends in the "more entries" button. */
  nexts: Readonly<Record<string, C | null | undefined>>
  /** The path of the row shown as selected. */
  selected?: string | undefined
  /** The order of a folder's rows; the order they were read in when omitted. */
  order?: ((a: E, b: E) => number) | undefined
  /**
   * Text to find. When not blank, the entries read so far that are not folders and
   * whose path contains it (ignoring case) are listed by path instead of the tree.
   */
  filter?: string | undefined
  /** What differs from a row's defaults ({@link TreeRow}), e.g. a kind that does not open or its own icon. */
  row?: ((entry: E, expanded: boolean) => Partial<TreeRow>) | undefined
  /** A folder row was activated: open or close it (and read it when it has no entries yet). */
  onToggle: (path: string) => void
  /** A row that is not a folder was activated. */
  onOpen: (entry: E) => void
  /** Read `path`'s next page, at `cursor`. */
  onMore: (path: string, cursor: C) => void
  /** What a folder being read shows instead of {@link FileTreeLabels.reading} (a timer, Cancel). */
  pending?: ((path: string) => ReactNode) | undefined
  /** What a folder whose read was refused shows instead of {@link FileTreeLabels.failed}. */
  failed?: ((path: string, error: Error) => ReactNode) | undefined
  /** A folder's "more entries" row; the default label when it answers nothing. */
  more?: ((path: string) => TreeMore | undefined) | undefined
  /** What a folder shows after its rows (a note that what is shown is a kept answer). */
  after?: ((path: string) => ReactNode) | undefined
  /** On the touch layout, a row's name and path wrap instead of ending in an ellipsis (a narrow side panel). */
  wrapNames?: boolean | undefined
  labels: FileTreeLabels
}

/** At most this many matches of the filter are listed. */
const MATCHES = 200

/** A row's parts: the caller's, else the defaults. */
function rowOf<E extends TreeEntry>(entry: E, expanded: boolean, row: FileTreeProps<E, never>['row']): TreeRow {
  const custom = row?.(entry, expanded) ?? {}
  const expandable = custom.expandable ?? entry.kind === 'dir'
  return {
    expandable,
    icon: custom.icon ?? (expandable ? (expanded ? <IconFolderOpenOutlineRegular size={16} /> : <IconFolderCloseRegular size={16} />)
      : entry.kind === 'symlink' ? <IconLinkOutlineRegular size={14} /> : <FileTypeIcon path={entry.name} size={16} />),
    title: custom.title ?? (expandable ? entry.path : `${entry.path} · ${bytes(entry.size)}`),
    disabled: custom.disabled, label: custom.label, secondary: custom.secondary, trailing: custom.trailing, below: custom.below,
  }
}

export function FileTree<E extends TreeEntry, C>(props: FileTreeProps<E, C>): ReactNode {
  return (props.filter ?? '').trim() ? <Matches {...props} /> : <Rows {...props} />
}

/** The entries read so far that match the filter, by path. */
function Matches<E extends TreeEntry, C>({ dirs, selected, filter = '', row, onOpen, labels, wrapNames }: FileTreeProps<E, C>): ReactNode {
  const q = filter.trim().toLowerCase()
  const folder = (entry: E) => row?.(entry, false).expandable ?? entry.kind === 'dir'
  const matches: E[] = []
  for (const dir of dirs.values()) {
    if (!Array.isArray(dir)) continue
    for (const entry of dir) {
      if (matches.length < MATCHES && !folder(entry) && entry.path.toLowerCase().includes(q)) matches.push(entry)
    }
  }
  if (matches.length === 0) return <p className={css.treeNote}>{labels.noMatch}</p>
  return (
    <ul className={clsx(css.tree, wrapNames && css.treeWrap)} aria-label={labels.tree}>
      {matches.map((n) => {
        const custom = row?.(n, false) ?? {}
        return (
          <li key={n.path} className={css.treeLine}>
            <button type="button" className={css.treeRow} data-active={n.path === selected || undefined} aria-disabled={custom.disabled || undefined}
              onClick={() => { if (!custom.disabled) onOpen(n) }} title={custom.title ?? n.path}>
              <span className={css.treeIcon}>{custom.icon ?? <FileTypeIcon path={n.name} size={16} />}</span>
              <span className={css.treePath}>{n.path}</span>
            </button>
            {custom.trailing != null ? <span className={css.treeTrailing}>{custom.trailing}</span> : null}
          </li>
        )
      })}
    </ul>
  )
}

/** A row as the keyboard sees it: an entry, or a folder's "more entries" button (no name). */
interface Shown {
  key: string
  /** The folder row it is under; null at the top. */
  parent: string | null
  name: string | null
  expandable: boolean
  expanded: boolean
}

/** The key of a folder's "more entries" row; `more` is its place among `dataset` keys, apart from any path. */
const moreKey = (path: string): string => `more ${path}`

/** Typed characters count as one word while they follow each other within this long. */
const TYPE_AHEAD_MS = 500

/** The tree: its rows in order, the one tab stop and the keys. */
function Rows<E extends TreeEntry, C>(props: FileTreeProps<E, C>): ReactNode {
  const { root = '/', dirs, open, nexts, selected, order, row, onToggle } = props
  // Each read folder's rows in the order they show, sorted once for drawing and for the keys.
  const sorted = useMemo(() => {
    const all = new Map<string, readonly E[]>()
    for (const [path, dir] of dirs) if (Array.isArray(dir)) all.set(path, order ? [...dir].sort(order) : dir)
    return all
  }, [dirs, order])
  const rows = useMemo(() => {
    const rows: Shown[] = []
    const walk = (path: string, parent: string | null) => {
      for (const entry of sorted.get(path) ?? []) {
        const expandable = row?.(entry, false).expandable ?? entry.kind === 'dir'
        const expanded = expandable && open.has(entry.path)
        rows.push({ key: entry.path, parent, name: row?.(entry, false).label ?? entry.name, expandable, expanded })
        if (expanded) walk(entry.path, entry.path)
      }
      if (sorted.has(path) && nexts[path] != null) rows.push({ key: moreKey(path), parent, name: null, expandable: false, expanded: false })
    }
    walk(root, null)
    return rows
  }, [sorted, open, nexts, root, row])

  // The row Tab enters the tree at: the one last focused, else the selected one, else the first.
  const [focus, setFocus] = useState<string | null>(null)
  const has = (key: string | null | undefined): key is string => key != null && rows.some((r) => r.key === key)
  const stop = has(focus) ? focus : has(selected) ? selected : rows[0]?.key
  const tree = useRef<HTMLUListElement>(null)
  const typed = useRef({ text: '', at: 0 })

  const keyOf = (target: EventTarget): string | undefined => (target as HTMLElement).closest<HTMLElement>('[data-tree-key]')?.dataset.treeKey
  const onFocus = (e: FocusEvent<HTMLUListElement>) => {
    const key = keyOf(e.target)
    if (key !== undefined) setFocus(key)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const key = keyOf(e.target)
    const at = rows.findIndex((r) => r.key === key)
    const here = rows[at]
    if (!here) return
    let to = -1
    if (e.key === 'ArrowDown') to = Math.min(at + 1, rows.length - 1)
    else if (e.key === 'ArrowUp') to = Math.max(at - 1, 0)
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = rows.length - 1
    else if (e.key === 'ArrowRight') {
      if (here.expandable && !here.expanded) onToggle(here.key)
      else if (here.expanded && rows[at + 1]?.parent === here.key) to = at + 1
    } else if (e.key === 'ArrowLeft') {
      if (here.expanded) onToggle(here.key)
      else if (here.parent !== null) to = rows.findIndex((r) => r.key === here.parent)
    } else if (e.key.length === 1 && (e.key !== ' ' || (typed.current.text && e.timeStamp - typed.current.at <= TYPE_AHEAD_MS))) {
      // Type-ahead: one character looks from the next row on, a longer word from this row; both wrap.
      const text = (e.timeStamp - typed.current.at <= TYPE_AHEAD_MS ? typed.current.text : '') + e.key.toLowerCase()
      typed.current = { text, at: e.timeStamp }
      for (let i = 0; i < rows.length; i++) {
        const j = (at + (text.length === 1 ? 1 : 0) + i) % rows.length
        if (rows[j]!.name?.toLowerCase().startsWith(text)) { to = j; break }
      }
    } else return
    e.preventDefault()
    if (to < 0 || to === at) return
    const target = rows[to]!.key
    for (const el of tree.current?.querySelectorAll<HTMLElement>('[data-tree-key]') ?? []) {
      if (el.dataset.treeKey === target) { el.focus(); break }
    }
  }

  return <Folder {...props} path={root} depth={0} sorted={sorted} stop={stop} top={{ ref: tree, onFocus, onKeyDown }} />
}

interface FolderProps<E extends TreeEntry, C> extends FileTreeProps<E, C> {
  path: string
  depth: number
  /** Each read folder's rows in order. */
  sorted: ReadonlyMap<string, readonly E[]>
  /** The key of the row that is the tab stop. */
  stop: string | undefined
  /** The outermost list's handlers. */
  top?: { ref: RefObject<HTMLUListElement>, onFocus: (e: FocusEvent<HTMLUListElement>) => void, onKeyDown: (e: KeyboardEvent<HTMLUListElement>) => void } | undefined
}

/** One folder's rows, each open folder's own rows under it. */
function Folder<E extends TreeEntry, C>({ top, ...props }: FolderProps<E, C>): ReactNode {
  const { path, depth, dirs, open, nexts, selected, sorted, stop, row, onToggle, onOpen, onMore, pending, failed, more, after, labels } = props
  const dir = dirs.get(path)
  const indent = { '--files-depth': depth } as CSSProperties
  if (dir === undefined || dir === 'loading') return <div className={css.treeNote} style={indent} data-tree-reading={path}>{pending?.(path) ?? labels.reading}</div>
  if (dir instanceof Error) {
    const custom = failed?.(path, dir)
    return custom != null
      ? <div className={clsx(css.treeNote, css.treeError)} style={indent} data-tree-failed={path}>{custom}</div>
      : <p className={clsx(css.treeNote, css.treeError)} style={indent} title={dir.message}>{labels.failed}</p>
  }
  if (dir.length === 0) return <p className={css.treeNote} style={indent} data-tree-empty={path}>{labels.empty}</p>
  const next = nexts[path]
  const tab = (key: string) => (key === stop ? 0 : -1)
  const further = next != null ? more?.(path) : undefined
  const trailer = after?.(path)
  return (
    <ul className={clsx(css.tree, depth === 0 && props.wrapNames && css.treeWrap)} role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? labels.tree : undefined} {...top}>
      {(sorted.get(path) ?? dir).map((n) => {
        const expanded = open.has(n.path)
        const { expandable, icon, title, disabled, label, secondary, trailing, below } = rowOf(n, expanded, row)
        const inside = expandable && expanded ? dirs.get(n.path) : null
        return (
          <li key={n.path} role="treeitem" aria-expanded={expandable ? expanded : undefined} aria-selected={n.path === selected}
            aria-busy={inside === undefined || inside === 'loading' || undefined}>
            <div className={css.treeLine}>
              <button type="button" className={css.treeRow} style={indent} data-active={n.path === selected || undefined} data-tree-key={n.path} data-tree-kind={n.kind} tabIndex={tab(n.path)}
                title={title} aria-disabled={disabled || undefined} onClick={() => { if (!disabled) { if (expandable) onToggle(n.path); else onOpen(n) } }}>
                {expandable
                  ? <IconChevronRightOutlineRegular size={12} className={clsx(css.chevron, expanded && css.chevronOpen)} />
                  : <span className={css.chevronSpace} />}
                <span className={css.treeIcon}>{icon}</span>
                <span className={css.treeName}>{label ?? n.name}{secondary ? <span className={css.treeSecondary}>{secondary}</span> : null}</span>
              </button>
              {trailing != null ? <span className={css.treeTrailing}>{trailing}</span> : null}
            </div>
            {below != null ? <div className={css.treeBelow} style={indent}>{below}</div> : null}
            {expandable && expanded ? <Folder {...props} path={n.path} depth={depth + 1} /> : null}
          </li>
        )
      })}
      {next != null ? (
        <li role="treeitem" className={css.treeMore}>
          <button type="button" className={css.linkButton} style={indent} data-tree-key={moreKey(path)} data-tree-more={path} tabIndex={tab(moreKey(path))}
            aria-disabled={further?.busy || undefined} onClick={() => { if (!further?.busy) onMore(path, next) }}>{further?.label ?? labels.more}</button>
          {further?.note != null ? <span className={css.treeMoreNote}>{further.note}</span> : null}
        </li>
      ) : null}
      {trailer != null ? <li role="none" className={css.treeNote} style={indent}>{trailer}</li> : null}
    </ul>
  )
}
