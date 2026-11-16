/**
 * Page bookkeeping for the history view: joining a Branch's new first page to
 * what was read at its old head, and counting its Commits without a read.
 * The tree itself is laid out in `tree-model.ts`.
 */
import type { HistoryBranch, HistoryPage } from './types.ts'

/**
 * A Branch's new first page joined to what was loaded at its old head: the new Commits above
 * the old head, then the old pages (or the new page's own tail when it reads deeper). Undefined
 * when the new page does not reach the old head (the caller reads on, or keeps the new page).
 */
export function extendPage(fresh: HistoryPage, old: HistoryPage): HistoryPage | undefined {
  const oldHead = old.items[0]?.id ?? old.head
  if (!oldHead || fresh.head === old.head) return old.items.length >= fresh.items.length ? old : fresh
  const at = fresh.items.findIndex((c) => c.id === oldHead)
  if (at < 0) return undefined
  const deeper = old.items.length >= fresh.items.length - at
  return { items: [...fresh.items.slice(0, at), ...(deeper ? old.items : fresh.items.slice(at))], next: deeper ? old.next : fresh.next, head: fresh.head }
}

/**
 * A side Branch's Commit count without a read, when the loaded page tells it: unchanged head,
 * nothing since the fork, a complete page, or a new page that reaches the last counted head.
 * Null when only the host can count it.
 */
export function movedCount(known: { head: string | null, count: number } | undefined, page: HistoryPage | undefined, branch: HistoryBranch): number | null {
  if (known && known.head === (branch.head ?? null)) return known.count
  if (branch.head && branch.head === branch.forkedFrom) return 0
  if (!page || page.head !== branch.head) return null
  if (page.next === null) return page.items.length
  if (!known?.head) return null
  const at = page.items.findIndex((c) => c.id === known.head)
  return at < 0 ? null : known.count + at
}

/**
 * The Commit total of `branches` once each has a count at its current head, else null. A
 * Branch without a head yet (a new session Branch) is not counted until its count arrives.
 */
export function countedTotal(branches: HistoryBranch[], counts: Readonly<Record<string, { head: string | null, count: number } | undefined>>): number | null {
  let total = 0
  for (const b of branches) {
    const known = counts[b.name]
    if (!known || known.head !== (b.head ?? null)) return null
    total += known.count
  }
  return branches.length ? total : null
}
