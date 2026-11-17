/**
 * The last size each Store's file was read at. store.status measures a
 * sqlite Store's file through its machine's worker, so a Store on a stopped
 * machine (or one whose worker does not answer) has no size to read. Its
 * card then shows the last size this home saw, marked with when it was seen,
 * instead of "Size unavailable". Kept in `<home>/stat/store-sizes.json` so a
 * restart keeps it; a Store that is no longer listed is forgotten.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface StoreSize { bytes: number, file: number, wal: number }
/** A size as the Storage view answers it: `seen` (and `stale`) only for a kept size. */
export type SizeAnswer = StoreSize & { seen?: number, stale?: true }

type Kept = Record<string, StoreSize & { at: number }>

export class StoreSizes {
  private kept: Kept | null = null
  readonly path: string
  private readonly now: () => number

  constructor(dir: string, now: () => number = Date.now) {
    this.path = join(dir, 'store-sizes.json')
    this.now = now
  }

  private load(): Kept {
    if (this.kept) return this.kept
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'))
      this.kept = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch { this.kept = {} }
    return this.kept!
  }

  /**
   * Each listed Store's size: the one read now (kept), else the last kept one
   * marked stale. `read` holds null where store.status had no size.
   */
  answer(rows: { name: string, size: StoreSize | null }[]): (SizeAnswer | null)[] {
    const kept = this.load()
    const at = this.now()
    let changed = false
    const listed = new Set(rows.map((r) => r.name))
    for (const name of Object.keys(kept)) if (!listed.has(name)) { delete kept[name]; changed = true }
    const out = rows.map(({ name, size }) => {
      if (size) {
        const old = kept[name]
        if (!old || old.bytes !== size.bytes || old.file !== size.file || old.wal !== size.wal || at - old.at > 60_000) { kept[name] = { ...size, at }; changed = true }
        return size
      }
      const old = kept[name]
      return old ? { bytes: old.bytes, file: old.file, wal: old.wal, seen: old.at, stale: true as const } : null
    })
    if (changed) this.save()
    return out
  }

  private save(): void {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true, mode: 0o700 })
      const tmp = `${this.path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.kept), { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch {}
  }
}
