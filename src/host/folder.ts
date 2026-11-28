/**
 * The LayerFS folder (docs/specs/layerfs-folder.md): where the LayerFS home and
 * this plugin's DSH x LayerFS home (`dsh/`) live, resolved once at service
 * start.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export interface FolderConfig {
  /** The LayerFS folder; default the pointer, else `~/.layerfs`. */
  folder?: string
  /** The LayerFS home; default `<folder>/home` when set up there, else `<folder>`. */
  home?: string
  /** The DSH x LayerFS home; default `<folder>/dsh`. */
  state?: string
}

export type FolderSource = 'config' | 'env' | 'pointer' | 'default'

/** The layout of the DSH x LayerFS home this build writes (docs/specs/layerfs-folder.md §2). */
export const LAYOUT = 2

export interface DshRecord {
  version: 1
  /** The DSH_HOME this folder belongs to. */
  owner: string
  /** This install's id (64 hex): Sandbox names and the runtime pin lease. */
  install: string
  /** The folder's layout ({@link LAYOUT}). */
  layout?: number
}

export interface Folder {
  folder: string
  folderSource: FolderSource
  home: string
  state: string
  /** The `state` folder is a fallback because `<folder>/dsh` belongs to another DSH_HOME. */
  stateTaken: string | null
  install: string
  /** `$DSH_HOME/layerfs.json`. */
  pointer: string
}

const abs = (v: unknown): string | undefined => typeof v === 'string' && v && isAbsolute(v) ? v : undefined
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const readJson = (path: string): any => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

export const dshHomeOf = (env: NodeJS.ProcessEnv = process.env): string => env.DSH_HOME ?? join(homedir(), '.dsh')
export const pointerPath = (dshHome: string): string => join(dshHome, 'layerfs.json')
export const dshRecordPath = (state: string): string => join(state, 'dsh.json')
export const readDshRecord = (state: string): DshRecord | undefined => {
  const r = readJson(dshRecordPath(state))
  return r && typeof r.owner === 'string' && typeof r.install === 'string' ? r : undefined
}

/** Resolve the folder, home and state; record a new state folder's owner and install id. */
export function resolveFolder(config: FolderConfig = {}, env: NodeJS.ProcessEnv = process.env): Folder {
  const dshHome = dshHomeOf(env)
  const pointer = pointerPath(dshHome)
  let folder: string, folderSource: FolderSource
  const pointed = abs(readJson(pointer)?.folder)
  if (abs(config.folder)) { folder = abs(config.folder)!; folderSource = 'config' }
  else if (abs(env.DSH_LAYERFS_FOLDER)) { folder = abs(env.DSH_LAYERFS_FOLDER)!; folderSource = 'env' }
  else if (pointed) { folder = pointed; folderSource = 'pointer' }
  else { folder = join(homedir(), '.layerfs'); folderSource = 'default' }

  const home = abs(config.home) ?? abs(env.DSH_LAYERFS_HOME) ?? abs(env.LAYERFS_HOME)
    ?? (existsSync(join(folder, 'home', 'layerfs.json')) ? join(folder, 'home') : folder)

  const explicit = abs(config.state) ?? abs(env.DSH_LAYERFS_STATE)
  let state = explicit ?? join(folder, 'dsh')
  let stateTaken: string | null = null
  const owned = readDshRecord(state)
  if (!explicit && owned && owned.owner !== dshHome) {
    stateTaken = state
    state = join(folder, `dsh-${sha(dshHome).slice(0, 8)}`)
  }

  let record = readDshRecord(state)
  if (!record) {
    record = { version: 1, owner: dshHome, install: sha(state), layout: LAYOUT }
    writeJson(dshRecordPath(state), record)
  }
  return { folder, folderSource, home, state, stateTaken, install: record.install, pointer }
}

/** Put a session folder's LayerFS files into `layerfs/` (binding.json, calls.jsonl); drop `.bak` leftovers. */
export function relayout(dir: string): void {
  const lfs = join(dir, 'layerfs')
  const pairs: Array<[string, string]> = [['layerfs.json', 'binding.json'], ['receipts.jsonl', 'calls.jsonl']]
  for (const [from, to] of pairs) {
    if (!existsSync(join(dir, from)) || existsSync(join(lfs, to))) continue
    mkdirSync(lfs, { recursive: true })
    renameSync(join(dir, from), join(lfs, to))
  }
  for (const name of safeList(dir)) if (name.startsWith('layerfs.json.') && name.endsWith('.bak') || name === 'layerfs.json.bak') rmSync(join(dir, name), { force: true })
}

const safeList = (dir: string): string[] => { try { return readdirSync(dir) } catch { return [] } }

/** The folder named by a pointer write: an absolute folder that exists or can be made. */
export function checkFolder(path: unknown): string {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw Object.assign(new Error('Choose a folder, written as an absolute path.'), { code: 'InvalidInput' })
  if (existsSync(path) && !statSync(path).isDirectory()) throw Object.assign(new Error(`${path} is not a folder.`), { code: 'InvalidInput' })
  return path
}
