/**
 * A SQLite Store's backups as data, for the Backups and Back up dialogs
 * (BackupDialogs.tsx) and the machine Stores card's Backups fact.
 *
 * A Store may be linked to several buckets, from several providers. Each link
 * is one backup: its state comes from its bucket's last listing (unknown
 * until listed). Backups and buckets are grouped by provider so that a new
 * provider is one more group, not a new layout.
 */
import { backupStateOf, listedOf, type BackupState } from './model.ts'
import type { BucketRow, StorageView, StoreBackupLink, StoreRow } from './types.ts'

/** What a backup needs: a missing or diverged copy first, then out of date (neutral), then fine. */
export type BackupHealth = 'problem' | 'stale' | 'current' | 'unknown'

export function healthOf(state: BackupState | null | undefined): BackupHealth {
  switch (state) {
    case 'missing':
    case 'both_changed': return 'problem'
    case 'store_changed':
    case 'bucket_changed': return 'stale'
    case 'current': return 'current'
    default: return 'unknown'
  }
}

export type OverviewBackupHealth =
  | { tone: 'danger', kind: 'problem', state: 'missing' | 'both_changed', at: number | null }
  | { tone: 'info', kind: 'none' | 'bucket_changed' | 'not_checked' | 'not_listed', at: number | null }
  | { tone: 'info', kind: 'store_changed', at: number | null, bucket: string | null }
  | { tone: 'ok', kind: 'ok', at: number | null }

const newestAt = (items: readonly { at: number | null }[]): number | null =>
  items.reduce<number | null>((n, x) => (x.at != null && (n === null || x.at > n) ? x.at : n), null)

/** Store Overview › Health › Backups row: red only for missing/conflict, neutral for none/changed/unchecked, green only when every copy is verified current. */
export function overviewBackupHealth(backups: readonly (Pick<StoreBackup, 'state' | 'at'> & { link?: { bucket: string } })[]): OverviewBackupHealth {
  if (!backups.length) return { tone: 'info', kind: 'none', at: null }
  const problem = backups.find((b): b is Pick<StoreBackup, 'at'> & { state: 'missing' | 'both_changed' } => b.state === 'both_changed' || b.state === 'missing')
  if (problem) return { tone: 'danger', kind: 'problem', state: problem.state, at: problem.at }
  const storeChanged = backups.filter((b) => b.state === 'store_changed')
  if (storeChanged.length) {
    const bucket = backups.length > 1 && storeChanged.length === 1 ? (storeChanged[0]!.link?.bucket ?? null) : null
    return { tone: 'info', kind: 'store_changed', at: newestAt(storeChanged), bucket }
  }
  const bucketChanged = backups.filter((b) => b.state === 'bucket_changed')
  if (bucketChanged.length) return { tone: 'info', kind: 'bucket_changed', at: newestAt(bucketChanged) }
  const notChecked = backups.filter((b) => b.state === 'unknown')
  if (notChecked.length) return { tone: 'info', kind: 'not_checked', at: newestAt(notChecked) }
  const notListed = backups.filter((b) => b.state !== 'current')
  if (notListed.length) return { tone: 'info', kind: 'not_listed', at: newestAt(notListed) }
  return { tone: 'ok', kind: 'ok', at: newestAt(backups) }
}

/** The copy with the newest known backup time (`listed.modified ?? link.last.at`), or null if none is dated. */
export function latestBackupCopy(backups: readonly StoreBackup[]): StoreBackup | null {
  return backups.reduce<StoreBackup | null>((best, b) => (b.at != null && (!best || b.at > best.at!) ? b : best), null)
}

const RANK: Record<BackupHealth, number> = { problem: 0, stale: 1, unknown: 2, current: 3 }

/**
 * The one thing a backup's row offers: back up under a new file (LayerFS will
 * not write over a copy that went missing: it is not the copy this home last
 * moved), bring it up to date, or restore from it.
 */
export type BackupAction = 'again' | 'update' | 'restore' | 'now'

export function actionOf(state: BackupState | null | undefined): BackupAction {
  switch (state) {
    case 'missing':
    case 'both_changed': return 'again'
    case 'store_changed': return 'update'
    case 'current':
    case 'bucket_changed': return 'restore'
    default: return 'now'
  }
}

/** LayerFS refuses overwriting a missing or diverged bucket object under the same file name. */
export const needsNewFileName = (state: BackupState | null | undefined): boolean =>
  state === 'missing' || state === 'both_changed' || state === 'bucket_changed'

export interface StoreBackup {
  link: StoreBackupLink
  provider: string | null
  state: BackupState | null
  health: BackupHealth
  /** When it was written: the listing's time, else the last backup this host ran. */
  at: number | null
  bytes: number | null
  /** LayerFS's note for this entry (for example when state is `unknown`). */
  message: string | null
  /** The bucket's last listing failure, when listing was refused or failed. */
  bucketError: BucketRow['error']
}

export interface ProviderGroup<T> { provider: string | null, items: T[] }

/** Groups by provider: the group with the most urgent item first, then by name; an unknown provider last. */
function byProvider<T>(items: readonly T[], provider: (x: T) => string | null, rank: (x: T) => number): ProviderGroup<T>[] {
  const groups = new Map<string | null, T[]>()
  for (const x of items) groups.set(provider(x), [...(groups.get(provider(x)) ?? []), x])
  const worst = (g: T[]) => Math.min(...g.map(rank))
  return [...groups.entries()]
    .map(([p, g]) => ({ provider: p, items: g }))
    .sort((a, b) => worst(a.items) - worst(b.items) || (a.provider === null ? 1 : b.provider === null ? -1 : a.provider.localeCompare(b.provider)))
}

/** Every backup of `s`, most urgent first, then newest. */
export function storeBackups(s: StoreRow, buckets: readonly BucketRow[]): StoreBackup[] {
  return s.links.map((link) => {
    const bucket = buckets.find((b) => b.name === link.bucket)
    const listed = listedOf(s, link.bucket, link.file, buckets)
    const state = backupStateOf(listed)
    return {
      link, state, health: healthOf(state),
      provider: bucket?.provider ?? null,
      at: listed?.modified ?? link.last?.at ?? null,
      bytes: listed?.bytes ?? link.last?.bytes ?? null,
      message: listed?.message ?? null,
      bucketError: bucket?.error ?? null,
    }
  }).sort((a, b) => RANK[a.health] - RANK[b.health] || (b.at ?? 0) - (a.at ?? 0) || a.link.bucket.localeCompare(b.link.bucket))
}

export const backupGroups = (backups: readonly StoreBackup[]): ProviderGroup<StoreBackup>[] =>
  byProvider(backups, (x) => x.provider, (x) => RANK[x.health])

/** How many backups need what, for the card's fact and the dialog's bar. */
export function backupCounts(backups: readonly StoreBackup[]): Record<BackupHealth, number> {
  const n: Record<BackupHealth, number> = { problem: 0, stale: 0, current: 0, unknown: 0 }
  for (const b of backups) n[b.health] += 1
  return n
}

/** The distinct providers of `s`'s backups, most backups first (the card's stacked marks). */
export function backupProviders(backups: readonly StoreBackup[]): (string | null)[] {
  const n = new Map<string | null, number>()
  for (const b of backups) n.set(b.provider, (n.get(b.provider) ?? 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p)
}

/** A bucket Back up can write to: the backup it would update, if `s` already has one there. */
export interface BackupTarget { bucket: BucketRow, backup: StoreBackup | null }

export function backupTargets(s: StoreRow, view: Pick<StorageView, 'buckets'>): ProviderGroup<BackupTarget>[] {
  const backups = storeBackups(s, view.buckets)
  const targets = [...view.buckets]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((bucket) => ({ bucket, backup: backups.find((x) => x.link.bucket === bucket.name) ?? null }))
  return byProvider(targets, (x) => x.bucket.provider, () => 0)
}

/**
 * The bucket Back up starts on: a bucket added since the dialog last opened
 * (Add a bucket returns here), else the backup that most needs writing, else
 * the first bucket.
 */
export function firstTarget(groups: readonly ProviderGroup<BackupTarget>[], known: readonly string[] | undefined): string {
  const all = groups.flatMap((g) => g.items)
  const added = known ? all.find((x) => !known.includes(x.bucket.name)) : undefined
  if (added) return added.bucket.name
  const linked = all.filter((x) => x.backup).sort((a, b) => RANK[a.backup!.health] - RANK[b.backup!.health])
  return linked[0]?.bucket.name ?? all[0]?.bucket.name ?? ''
}

/**
 * A file name for a backup whose copy went missing (`file`): its name with the
 * next number, `orders-2`, `orders-3`… (counting on from a number it already
 * ends in), never `file` itself nor a name in the bucket's listing (`taken`).
 */
export function freshName(file: string, taken: readonly string[]): string {
  const base = file.replace(/-\d+$/, '')
  for (let n = 2; ; n += 1) {
    const name = `${base}-${n}`
    if (name !== file && !taken.includes(name)) return name
  }
}
