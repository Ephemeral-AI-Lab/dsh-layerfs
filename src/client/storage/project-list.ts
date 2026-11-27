/**
 * The Overview's Projects tab: which project cards a search keeps and the
 * order a sort puts them in. Pure, so the page and the tests share it.
 *
 * - A search keeps a project whose name or Store name holds the text (any case).
 * - Last session (the default) puts the project whose session changed last
 *   first, by an order worked out once the session lists are read (or the page
 *   refreshed, or the projects changed), so rows never move while sessions run
 *   and write at different speeds; a project with no session goes after, in
 *   the default order.
 * - Default keeps the cards' own order (trouble first, then the Stores' order).
 * - Size puts the largest first, by an order worked out when Size is picked (or
 *   the page refreshed), so cards do not move as counts finish; a project
 *   without a size then (still counting, or new since) goes last.
 * - Name sorts A to Z.
 */

export type ProjectSort = 'session' | 'default' | 'size' | 'name'
export const PROJECT_SORTS: readonly ProjectSort[] = ['session', 'default', 'size', 'name']
/** The order the Projects tab starts in. */
export const DEFAULT_SORT: ProjectSort = 'session'

/** `GET /api/projects/<key>/size`. */
export interface ProjectSize { project: string, stored: number | null, counting: boolean }

/** The `useQuery` cache key a project card keeps its size under (`store/project`). */
export const sizeCacheKey = (key: string): string => `project-size:${key}`

/** Whether a search keeps this project. */
export function projectMatches(store: string, project: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase()
  return q === '' || project.toLocaleLowerCase().includes(q) || store.toLocaleLowerCase().includes(q)
}

/** Project keys largest first; those without a size last, in the order given. */
export function sizeOrder(keys: readonly string[], sizeOf: (key: string) => number | null): string[] {
  const at = new Map(keys.map((k, i) => [k, i]))
  const size = new Map(keys.map((k) => [k, sizeOf(k)]))
  return [...keys].sort((a, b) => {
    const x = size.get(a) ?? null, y = size.get(b) ?? null
    if (x === null || y === null) return x === y ? at.get(a)! - at.get(b)! : x === null ? 1 : -1
    return y - x || at.get(a)! - at.get(b)!
  })
}

/** Project keys whose last session is newest first; those without a session last, in the order given. */
export function sessionOrder(keys: readonly string[], lastOf: (key: string) => number | null): string[] {
  return sizeOrder(keys, lastOf)
}

/**
 * The cards a search keeps, in the sort's order. `items` come in the default
 * order; `frozen` is the Size or Last session order (see {@link sizeOrder}, {@link sessionOrder}).
 */
export function orderProjects<T extends { store: string, project: string }>(items: readonly T[], query: string, sort: ProjectSort, frozen: readonly string[] | null): T[] {
  const kept = items.filter((i) => projectMatches(i.store, i.project, query))
  if (sort === 'name') return [...kept].sort((a, b) => a.project.localeCompare(b.project) || a.store.localeCompare(b.store))
  if ((sort === 'size' || sort === 'session') && frozen) {
    const rank = new Map(frozen.map((k, i) => [k, i]))
    const of = (i: T) => rank.get(`${i.store}/${i.project}`) ?? Number.MAX_SAFE_INTEGER
    return kept.map((i, at) => ({ i, at })).sort((a, b) => of(a.i) - of(b.i) || a.at - b.at).map(({ i }) => i)
  }
  return kept
}
