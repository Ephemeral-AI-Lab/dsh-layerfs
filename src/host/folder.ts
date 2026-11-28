/**
 * The LayerFS folder (docs/specs/layerfs-folder.md): where the LayerFS home and
 * this plugin's DSH x LayerFS home (`dsh/`) live, resolved once at service
 * start, and the one-time migration of an older install's `$DSH_HOME/layerfs`.
 */
import { createHash } from 'node:crypto'
import { constants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export interface FolderConfig {
  /** The LayerFS folder; default the pointer, else `~/.layerfs`. */
  folder?: string
  /** The LayerFS home; default `<folder>/home` when set up there, else `<folder>`. */
  home?: string
  /** The DSH x LayerFS home; default `<folder>/dsh`. */
  state?: string
  /** Older name of `state` (before the folder layout it was `$DSH_HOME/layerfs`). */
  root?: string
  /** Older override of the project-session home: read once as a migration source. */
  projectSessionHome?: string
}

export type FolderSource = 'config' | 'env' | 'pointer' | 'default'

export interface DshRecord {
  version: 1
  /** The DSH_HOME this folder belongs to. */
  owner: string
  /** This install's id (64 hex): Sandbox names and the runtime pin lease. */
  install: string
  migratedFrom?: string
  migratedAt?: string
}

export interface Folder {
  folder: string
  folderSource: FolderSource
  home: string
  state: string
  /** The `state` folder is a fallback because `<folder>/dsh` belongs to another DSH_HOME. */
  stateTaken: string | null
  install: string
  /** Where this install's state was migrated from, when it was. */
  migratedFrom: string | null
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

/** Resolve the folder, home and state; migrate an older install's state on first start. Never throws for a migration. */
export function resolveFolder(config: FolderConfig = {}, env: NodeJS.ProcessEnv = process.env, log: (message: string) => void = () => {}): Folder {
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

  const legacy = join(dshHome, 'layerfs')
  const explicit = abs(config.state) ?? abs(config.root) ?? abs(env.DSH_LAYERFS_STATE)
  let state = explicit ?? join(folder, 'dsh')
  let stateTaken: string | null = null
  const owned = readDshRecord(state)
  if (!explicit && owned && owned.owner !== dshHome) {
    stateTaken = state
    state = join(folder, `dsh-${sha(dshHome).slice(0, 8)}`)
  }

  let record = readDshRecord(state)
  if (!record) {
    // The state an older build kept: config `root` names it (it is then also the new
    // state folder), else `$DSH_HOME/layerfs`.
    // A configured `root` was the old folder itself: `$DSH_HOME/layerfs` was never this install's then.
    const source = abs(config.root) ? (hasOldState(abs(config.root)!) ? abs(config.root)! : null) : (hasOldState(legacy) && legacy !== state ? legacy : null)
    const sessionHome = abs(config.projectSessionHome) ?? abs(env.DSH_LAYERFS_SESSION_HOME)
    record = { version: 1, owner: dshHome, install: sha(source ?? state) }
    if (source) {
      try {
        migrate(source, state, sessionHome ?? join(source, 'project-sessions'), log)
        record.migratedFrom = source
        record.migratedAt = new Date().toISOString()
      } catch (error: any) {
        log(`dsh-layerfs: moving ${source} to ${state} failed (${error?.message ?? error}); the old folder is kept`)
        throw error
      }
    }
    writeJson(dshRecordPath(state), record)
  }
  return { folder, folderSource, home, state, stateTaken, install: record.install, migratedFrom: record.migratedFrom ?? null, pointer }
}

/** Whether a folder holds an older build's plugin state. */
function hasOldState(dir: string): boolean {
  return ['sessions.json', 'runtime.json', 'project-sessions', 'simulations'].some((n) => existsSync(join(dir, n))) && !existsSync(dshRecordPath(dir))
}

/** Copy one entry (APFS clone where possible); no-op when the source is missing. */
function copy(from: string, to: string): boolean {
  if (!existsSync(from)) return false
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE } as any)
  return true
}

const dirs = (dir: string): string[] => {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return [] }
}

/**
 * Copy an older install's state into the new layout, then set the copied
 * entries aside in the old folder (`<name>.moved`). The old `scratch/` and
 * `projects/` stay: sessions and DSH's workspace registry name them by path.
 */
export function migrate(source: string, state: string, sessionHome: string, log: (message: string) => void = () => {}): void {
  mkdirSync(state, { recursive: true, mode: 0o700 })
  const moved: string[] = []
  // In place (config `root` names both): an entry already where it belongs stays.
  const take = (name: string, to: string): void => { if (join(source, name) !== to && copy(join(source, name), to)) moved.push(name) }
  take('runtime.json', join(state, 'runtime.json'))
  take('sessions.json', join(state, 'sessions', 'state.json'))
  take('simulations', join(state, 'simulations'))
  take('simulation-scratch', join(state, 'simulations', 'scratch'))
  if (source !== state && copy(join(source, 'trace', 'outputs'), join(state, 'trace', 'outputs'))) moved.push('trace')
  for (const n of ['store-machines.json', 'images', 'presets', 'agent-bin', 'project-sources', 'archive-imports']) if (existsSync(join(source, n))) moved.push(n)

  // Project sessions: indexes, backups, then each owned log with its sidecar in layerfs/.
  const sessions = join(state, 'sessions')
  copy(join(sessionHome, 'owners.json'), join(sessions, 'owners.json'))
  copy(join(sessionHome, 'deleted.json'), join(sessions, 'deleted.json'))
  copy(join(sessionHome, 'project-catalog.json'), join(sessions, 'projects.json'))
  copy(join(sessionHome, 'migration-backups'), join(sessions, 'backups'))
  const owners = readJson(join(sessionHome, 'owners.json'))?.sessions ?? {}
  let count = 0
  for (const owner of dirs(join(sessionHome, 'projects'))) {
    const root = join(sessionHome, 'projects', owner, 'sessions')
    for (const cwd of dirs(root)) {
      for (const id of dirs(join(root, cwd))) {
        // A copy left behind by an older log migration names another owner: only the owned one moves.
        const route = owners[id]
        if (route && route.key !== owner && (route.identity?.id ?? route.key) !== owner) continue
        const to = join(sessions, 'store', cwd, id)
        if (existsSync(to)) { log(`dsh-layerfs: ${id} already in ${join(sessions, 'store', cwd)}; kept`); continue }
        copy(join(root, cwd, id), to)
        relayout(to)
        count++
      }
    }
  }
  if (existsSync(sessionHome)) moved.push(sessionHome === join(source, 'project-sessions') ? 'project-sessions' : sessionHome)

  for (const name of moved) {
    const from = isAbsolute(name) ? name : join(source, name)
    try { if (existsSync(from)) renameSync(from, `${from}.moved`) } catch { /* left in place; the record says it moved */ }
  }
  try {
    writeFileSync(join(source, 'MOVED.txt'), `This DeepSeek Harness LayerFS state moved to ${state} on ${new Date().toISOString()}.\n`
      + 'Entries ending in .moved are the copies it was made from and can be deleted once that install works.\n'
      + 'scratch/ and projects/ stay here: sessions and DeepSeek Harness workspaces still use them.\n')
  } catch { /* advisory */ }
  log(`dsh-layerfs: moved ${source} to ${state} (${count} project sessions)`)
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
