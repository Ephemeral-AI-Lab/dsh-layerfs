/**
 * The folders the setup modal's folder tree lists under each home, and opens
 * by name (`setup.open {which, part}`). A fixed list: the host opens only
 * these, never a path the page sends. `secret/` and LayerFS's own lock and
 * run files are left out on purpose.
 */
export const FOLDER_PARTS = {
  home: ['store', 'machine', 'sandbox', 'runtime', 'backup', 'log', 'trace'],
  dsh: ['sessions', 'scratch', 'trace', 'simulations'],
} as const

export type FolderWhich = 'folder' | 'home' | 'dsh'
export type FolderPart = (typeof FOLDER_PARTS)[keyof typeof FOLDER_PARTS][number]

/** One listed folder: how many entries it holds and the first few names (sorted), or absent when it is not there. */
export interface FolderEntry {
  readonly name: FolderPart
  readonly count: number
  readonly names: readonly string[]
}

/** `setup.contents`: what each home holds, read with one directory listing per folder. */
export interface FolderContents {
  readonly home: readonly FolderEntry[]
  readonly dsh: readonly FolderEntry[]
}

export const isFolderPart = (which: unknown, part: unknown): part is FolderPart =>
  (which === 'home' || which === 'dsh') && (FOLDER_PARTS[which] as readonly unknown[]).includes(part)
