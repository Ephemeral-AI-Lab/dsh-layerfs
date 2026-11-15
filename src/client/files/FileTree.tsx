/**
 * A folder tree whose folders are read as they open: the rows, "more entries"
 * paging and a filter over the entries read so far. Shared by the project file
 * view and the machine and Sandbox file views. The caller owns what a folder
 * read asks ({@link useFolders}' `read`), which folders are open, the order of
 * the rows and what opening a row does.
 */
import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from 'react'
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
  }
}

export function FileTree<E extends TreeEntry, C>(props: FileTreeProps<E, C>): ReactNode {
  const { root = '/', dirs, selected, filter = '', row, onOpen, labels } = props
  const q = filter.trim().toLowerCase()
  if (!q) return <Folder {...props} path={root} depth={0} />
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
    <ul className={css.tree} aria-label={labels.tree}>
      {matches.map((n) => (
        <li key={n.path}>
          <button type="button" className={css.treeRow} data-active={n.path === selected || undefined} onClick={() => onOpen(n)} title={n.path}>
            <span className={css.treeIcon}><FileTypeIcon path={n.name} size={16} /></span>
            <span className={css.treePath}>{n.path}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** One folder's rows, each open folder's own rows under it. */
function Folder<E extends TreeEntry, C>(props: FileTreeProps<E, C> & { path: string, depth: number }): ReactNode {
  const { path, depth, dirs, open, nexts, selected, order, row, onToggle, onOpen, onMore, labels } = props
  const dir = dirs.get(path)
  const indent = { '--files-depth': depth } as CSSProperties
  if (dir === undefined || dir === 'loading') return <p className={css.treeNote} style={indent}>{labels.reading}</p>
  if (dir instanceof Error) return <p className={clsx(css.treeNote, css.treeError)} style={indent} title={dir.message}>{labels.failed}</p>
  if (dir.length === 0) return <p className={css.treeNote} style={indent}>{labels.empty}</p>
  const next = nexts[path]
  return (
    <ul className={css.tree} role={depth === 0 ? 'tree' : 'group'} aria-label={depth === 0 ? labels.tree : undefined}>
      {(order ? [...dir].sort(order) : dir).map((n) => {
        const expanded = open.has(n.path)
        const { expandable, icon, title } = rowOf(n, expanded, row)
        return (
          <li key={n.path} role="treeitem" aria-expanded={expandable ? expanded : undefined} aria-selected={n.path === selected}>
            <button type="button" className={css.treeRow} style={indent} data-active={n.path === selected || undefined}
              title={title} onClick={() => (expandable ? onToggle(n.path) : onOpen(n))}>
              {expandable
                ? <IconChevronRightOutlineRegular size={12} className={clsx(css.chevron, expanded && css.chevronOpen)} />
                : <span className={css.chevronSpace} />}
              <span className={css.treeIcon}>{icon}</span>
              <span className={css.treeName}>{n.name}</span>
            </button>
            {expandable && expanded ? <Folder {...props} path={n.path} depth={depth + 1} /> : null}
          </li>
        )
      })}
      {next != null ? <li><button type="button" className={css.linkButton} style={indent} onClick={() => onMore(path, next)}>{labels.more}</button></li> : null}
    </ul>
  )
}
