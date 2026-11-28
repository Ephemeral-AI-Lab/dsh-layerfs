/**
 * One-shot migration of a DSH x LayerFS home to the current layout (dsh.json
 * `layout: 2`), so no code path has to read an older shape:
 *
 * - session folders: `layerfs.json`/`receipts.jsonl` beside the log move into
 *   `layerfs/`; a binding carrying its calls (`invocations`) moves them to
 *   `layerfs/calls.jsonl` (reads folded into the counter as before); `.bak`
 *   leftovers go;
 * - bindings that recorded a scratch folder or anchor in the folder an older
 *   build used get the current Scratch folder (`<state>/scratch/<session>`),
 *   with the old folder's contents moved there;
 * - sessions placed in the retired Scratch project become plain folder
 *   sessions (binding, pending choice and owner route dropped);
 * - `state.group` and per-project `workspaceId`s go; project anchors point at
 *   the Scratch folder.
 *
 * {@link retireOldFolder} then (with the workspace registry, once the host is
 * up) moves the old Scratch workspace's conversations to the current one,
 * unregisters every workspace in the old folder, and deletes that folder and
 * `sessions/backups`. Temporary: removed once every install has run it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { compactInvocations, RECEIPT_META } from './layerfs/tracing.ts'
import { dshRecordPath, readDshRecord, writeJson } from './folder.ts'

export const LAYOUT = 2
const SCRATCH_PROJECT = 'dsh-scratch/scratch'

const readJson = (path: string): any => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }
const dirs = (dir: string): string[] => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) } catch { return [] } }
const list = (dir: string): string[] => { try { return readdirSync(dir) } catch { return [] } }
const under = (path: unknown, root: string): path is string => typeof path === 'string' && (path === root || path.startsWith(`${root}/`))

export interface MigrateReport { sessions: number, combined: number, scratch: number, dropped: string[] }

/** Bring `state` to {@link LAYOUT}; a no-op once dsh.json records it. Throws on a failed step (nothing is marked done). */
export function migrateLayout(state: string, log: (message: string) => void = () => {}): MigrateReport | null {
  const record: any = readDshRecord(state)
  if (!record || record.layout >= LAYOUT) return null
  const report: MigrateReport = { sessions: 0, combined: 0, scratch: 0, dropped: [] }
  const store = join(state, 'sessions', 'store')
  for (const cwd of dirs(store)) for (const id of dirs(join(store, cwd))) {
    report.sessions++
    if (sessionFolder(join(store, cwd, id))) report.combined++
  }

  const statePath = join(state, 'sessions', 'state.json')
  const ownersPath = join(state, 'sessions', 'owners.json')
  const s = readJson(statePath)
  const owners = readJson(ownersPath)
  const old: string | undefined = record.migratedFrom
  const scratchRoot = join(state, 'scratch')
  if (s) {
    for (const [id, b] of Object.entries<any>(s.sessions ?? {})) {
      if (b?.project === SCRATCH_PROJECT) { delete s.sessions[id]; report.dropped.push(id); continue }
    }
    for (const [id, p] of Object.entries<any>(s.pending ?? {})) if (p?.project === SCRATCH_PROJECT) { delete s.pending[id]; if (!report.dropped.includes(id)) report.dropped.push(id) }
    delete s.projects?.[SCRATCH_PROJECT]
    if (old) {
      // Project sessions first: a shared child takes its parent's folder.
      const moved = new Map<string, string>()
      for (const b of Object.values<any>(s.sessions ?? {})) {
        if (under(b.anchor, old)) b.anchor = scratchRoot
        if (b.kind !== 'project' || !under(b.scratch, old)) continue
        const to = join(scratchRoot, b.sessionId)
        moveFolder(b.scratch, to)
        moved.set(b.scratch, to)
        b.scratch = to
        b.scratchManaged = true
        report.scratch++
      }
      for (const b of Object.values<any>(s.sessions ?? {})) {
        if (b.kind !== 'shared' || !under(b.scratch, old)) continue
        const parent = b.parent ? s.sessions[b.parent] : undefined
        b.scratch = moved.get(b.scratch) ?? parent?.scratch ?? join(scratchRoot, b.parent ?? b.sessionId)
        b.scratchManaged = false
        report.scratch++
      }
      for (const p of Object.values<any>(s.pending ?? {})) if (under(p?.scratch, old)) delete p.scratch
    }
    for (const p of Object.values<any>(s.projects ?? {})) { delete p.workspaceId; if (!old || under(p.anchor, old)) p.anchor = scratchRoot }
    delete s.group
    writeJson(statePath, s)
  }
  if (owners?.sessions) {
    let changed = false
    for (const [id, route] of Object.entries<any>(owners.sessions)) {
      if (route?.project === SCRATCH_PROJECT) { delete owners.sessions[id]; changed = true; if (!report.dropped.includes(id)) report.dropped.push(id) }
    }
    if (changed) writeJson(ownersPath, owners)
  }
  writeJson(dshRecordPath(state), { ...record, layout: LAYOUT })
  log(`dsh-layerfs: migrated ${state} to layout ${LAYOUT} (${report.sessions} sessions, ${report.combined} combined bindings, ${report.scratch} scratch folders, ${report.dropped.length} Scratch-project sessions now plain)`)
  return report
}

/** One session folder: relayout, convert a combined binding, drop `.bak`. Returns whether it was combined. */
function sessionFolder(dir: string): boolean {
  const lfs = join(dir, 'layerfs')
  for (const [from, to] of [['layerfs.json', 'binding.json'], ['receipts.jsonl', 'calls.jsonl']]) {
    if (!existsSync(join(dir, from)) || existsSync(join(lfs, to))) continue
    mkdirSync(lfs, { recursive: true })
    renameSync(join(dir, from), join(lfs, to))
  }
  for (const name of [...list(dir).map((n) => join(dir, n)), ...list(lfs).map((n) => join(lfs, n))]) {
    if (/\.json(\.[^/]*)?\.bak$/.test(name)) rmSync(name, { force: true })
  }
  const bindingPath = join(lfs, 'binding.json')
  const binding = readJson(bindingPath)
  if (!binding || (!Array.isArray(binding.invocations) && binding[RECEIPT_META]?.foldedThrough === undefined)) return false
  const callsPath = join(lfs, 'calls.jsonl')
  if (Array.isArray(binding.invocations)) {
    const folded = compactInvocations(binding[RECEIPT_META], binding.invocations)
    const existing = existsSync(callsPath) ? readFileSync(callsPath, 'utf8').split('\n').filter(Boolean) : []
    const ids = new Set(existing.map((line) => { try { return JSON.parse(line)?.id } catch { return undefined } }).filter(Boolean))
    const lines = [...folded.invocations.filter((row) => !row?.id || !ids.has(row.id)).map((row) => JSON.stringify(row)), ...existing]
    writeAtomic(callsPath, lines.length ? `${lines.join('\n')}\n` : '')
    binding[RECEIPT_META] = folded.meta
    delete binding.invocations
  }
  if (binding[RECEIPT_META]) delete binding[RECEIPT_META].foldedThrough
  writeAtomic(bindingPath, `${JSON.stringify(binding, null, 2)}\n`)
  return true
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

/** Move a scratch folder's contents into `to` (made when missing); an entry already there is kept. */
function moveFolder(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  if (!existsSync(from) || !statSync(from).isDirectory()) return
  for (const name of list(from)) {
    const target = join(to, name)
    if (existsSync(target)) continue
    try { renameSync(join(from, name), target) } catch { cpSync(join(from, name), target, { recursive: true, preserveTimestamps: true }) }
  }
}

interface Registry {
  list(): Array<{ id: unknown, path: string, title?: string, sessionIds: readonly unknown[] }>
  delete(id: never): Promise<boolean> | boolean
}

/**
 * Finish the move away from an older build's folder (dsh.json `migratedFrom`):
 * its Scratch workspace's conversations join `scratch`, every workspace
 * registered inside it is unregistered (logs are never deleted), then the old
 * folder and `sessions/backups` are deleted and `migratedFrom` is dropped.
 */
export async function retireOldFolder(state: string, registry: Registry, scratch: () => Promise<{ workspaceId: string }>, attach: (workspaceId: string, sessionId: string) => Promise<void>, log: (message: string) => void = () => {}): Promise<void> {
  const record: any = readDshRecord(state)
  const old: string | undefined = record?.migratedFrom
  if (!record || record.layout < LAYOUT || !old) return
  const stale = registry.list().filter((w) => under(w.path, old))
  const orphans = stale.filter((w) => w.path === join(old, 'scratch')).flatMap((w) => w.sessionIds.map(String))
  if (orphans.length) {
    const { workspaceId } = await scratch()
    for (const id of orphans) await attach(workspaceId, id)
  }
  for (const w of stale) await registry.delete(String(w.id) as never)
  rmSync(old, { recursive: true, force: true })
  rmSync(join(state, 'sessions', 'backups'), { recursive: true, force: true })
  const { migratedFrom: _from, migratedAt: _at, ...rest } = record
  writeJson(dshRecordPath(state), rest)
  log(`dsh-layerfs: removed ${old} (${stale.length} workspaces unregistered, ${orphans.length} conversations moved to Scratch)`)
}
