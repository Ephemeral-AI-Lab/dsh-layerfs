/**
 * Backup states LayerFS 2.0 leaves `unknown` for a SQLite Store on another
 * machine, settled from public calls.
 *
 * `backup.list` decides a linked copy's state from two halves: whether the
 * Store changed since the link's last transfer (its heads digest now against
 * the link's) and whether the bucket's copy did (its sha256 against the
 * link's). The pinned CLI reads the Store half from the Store file on this
 * host only ("Store <s> is on <machine>; its heads are read on native
 * only", `control/crates/layerfs-store/src/backup/list.rs`), so every backup
 * of a Store on a VM or container machine lists as `unknown`, however fresh.
 * The fix belongs in LayerFS (read the heads through the machine's worker, as
 * `backup.create` already stages its snapshot there); until then:
 *
 * - The Store half: before a backup of such a Store, the host takes a
 *   history fingerprint from public calls (each project's newest main Layer,
 *   every Branch's base and head; the same rows the heads digest covers) and
 *   keeps it with the sha256 the backup moved. At a listing it takes the
 *   fingerprint again: equal means the Store has not changed since. A mark
 *   is trusted only while the link's last transfer is still that backup
 *   (same sha256); a backup made elsewhere has no mark and stays `unknown`.
 * - The bucket half: the copy's `layerfs-heads` metadata (the listing's
 *   `heads`) against the heads the link recorded.
 *
 * The fingerprint is the host's own: it is never compared with LayerFS's
 * heads digest, only with an earlier fingerprint of the same Store.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pages, type Lfs } from '../layerfs/cli.ts'

/** The reason prefix of LayerFS's `unknown` for a Store on another machine. */
const REMOTE = /^Store \S+ is on \S+; its heads are read on native only$/

/** A mark: what the host knew of a Store when it backed it up to one bucket file. */
export interface BackupMark {
  /** The sha256 the backup moved (the link's `last.sha256` while it is the last transfer). */
  sha256: string
  /** The Store's history fingerprint taken just before the backup. */
  fingerprint: string
  at: number
}

/**
 * A SQLite Store's history fingerprint from public calls: sorted lines
 * `stack <project> <newest main Layer>` and `branch <project> <name> <base>
 * <head or ->`, one per Branch other than main, hashed. It changes when a
 * project is added or removed, a Branch is made, moved, merged or deleted, a
 * Commit lands or main publishes.
 */
export async function historyFingerprint(lfs: Lfs, store: string): Promise<string> {
  const projects = await pages((p) => lfs.project.list(store, p))
  const lines: string[] = []
  for (const project of projects) {
    const ref = String(project.project ?? `${store}/${project.name}`)
    const name = String(project.name ?? ref.split('/').slice(1).join('/'))
    const [branches, main] = await Promise.all([
      pages((p) => lfs.branch.list(ref, p)),
      lfs.branch.commits(ref, 'main', { page: 1, page_size: 1 }),
    ])
    lines.push(`stack ${name} ${main?.items?.[0]?.id ?? '-'}`)
    for (const b of branches) if (b.name !== 'main') lines.push(`branch ${name} ${b.name} ${b.base ?? '-'} ${b.head ?? '-'}`)
  }
  lines.sort()
  return createHash('sha256').update(lines.map((l) => `${l}\n`).join('')).digest('hex')
}

const markKey = (store: string, bucket: string, file: string) => JSON.stringify([store, bucket, file])

/** The marks, one JSON file in the host's stat folder. */
export class BackupMarks {
  private readonly file: string
  private marks: Record<string, BackupMark>

  constructor(dir: string) {
    this.file = join(dir, 'backup-marks.json')
    try { this.marks = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {} } catch { this.marks = {} }
  }

  get(store: string, bucket: string, file: string): BackupMark | undefined {
    return this.marks[markKey(store, bucket, file)]
  }

  set(store: string, bucket: string, file: string, mark: BackupMark): void {
    this.marks[markKey(store, bucket, file)] = mark
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.marks), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

/** The state from the two halves, as `backup.list` names it. */
export function stateOf(storeChanged: boolean, bucketChanged: boolean): 'current' | 'store_changed' | 'bucket_changed' | 'both_changed' {
  return storeChanged ? (bucketChanged ? 'both_changed' : 'store_changed') : bucketChanged ? 'bucket_changed' : 'current'
}

/** Whether a listing item is `unknown` only because its Store is on another machine. */
export const remoteOnly = (item: { state?: string, reason?: string | null }) => item.state === 'unknown' && typeof item.reason === 'string' && REMOTE.test(item.reason)

/**
 * Settles the listing's `unknown` items whose Store is on another machine.
 * `stores` are store.list items (with `backups`). A settled item keeps the
 * CLI's word in `reason` no longer; it gets `checked: 'host'`. An item that
 * cannot be settled keeps LayerFS's state, its reason, and `untracked: true`
 * when no backup from this host marked it.
 */
export async function settleRemote(items: any[], bucket: string, stores: readonly any[], marks: BackupMarks, fingerprint: (store: string) => Promise<string>): Promise<any[]> {
  const now = new Map<string, Promise<string | null>>()
  const current = (store: string) => {
    if (!now.has(store)) now.set(store, fingerprint(store).catch(() => null))
    return now.get(store)!
  }
  return Promise.all(items.map(async (item) => {
    if (!remoteOnly(item) || !item.store) return item
    const link = stores.find((s) => s.name === item.store)?.backups?.[bucket]
    if (!link || (link.file ?? item.store) !== item.file) return item
    const mark = marks.get(item.store, bucket, item.file)
    if (!mark || mark.sha256 !== link.last?.sha256) return { ...item, untracked: true }
    if (!item.heads || !link.heads) return item
    const fp = await current(item.store)
    if (fp === null) return item
    return { ...item, state: stateOf(fp !== mark.fingerprint, item.heads !== link.heads), reason: null, checked: 'host' }
  }))
}
