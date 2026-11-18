/* Read-only CLI inventory shared by preset and environment cleanup (LayerFS 2.0 list and get shapes). */
const fail = message => { throw new Error(message) }
/** The key each family's 2.0 rows are named by; the presets key every row by `name`. */
const KEY = { machine: 'machine', store: 'store', sandbox: 'sandbox' }
/** A 2.0 row as the presets read it: `name`, a Store's `kind` (its engine). */
const rowOf = (family, row) => ({ ...row, name: row[KEY[family]] ?? row.name, ...(family === 'store' ? { kind: row.engine ?? row.kind } : {}) })
export class CliInventory {
  constructor(driver) { this.driver = driver }
  async query(argv) { return this.driver.invoke(argv, { read: true }) }
  /** Every row of `machine`, `store` or `sandbox list --detail`, by cursor (store and machine lists are not paged). */
  async inventory(family) {
    const items = []; let cursor = null
    do {
      const paged = family === 'sandbox'
      const result = await this.query([family, 'list', '--detail', ...(paged ? ['--limit', '1000', ...(cursor ? ['--cursor', cursor] : [])] : [])])
      const values = result?.items
      if (!Array.isArray(values)) fail(`Cannot verify cleanup: invalid ${family} inventory.`)
      items.push(...values.map(row => rowOf(family, row)))
      const next = paged ? result.next_cursor ?? null : null
      if (next !== null && (typeof next !== 'string' || next === cursor)) fail(`Cannot verify cleanup: invalid ${family} pagination.`)
      cursor = next
    } while (cursor !== null)
    return items
  }
  /**
   * `sandbox get <name> --detail` (unpaged: at most 16 Workspaces), each
   * Workspace with `ws` (its handle) and `name`. A blocked or broken Sandbox
   * answers no Workspaces: `incomplete` with `allowDown`, else a failure.
   */
  async sandboxDetails(name, { allowDown = false } = {}) {
    const result = await this.query(['sandbox', 'get', name, '--detail'])
    const down = result?.state === 'blocked' || result?.state === 'broken' ? (result.reason ?? result.blocked_by?.reason ?? result.state) : null
    if (down && allowDown) return { ...result, workspaces: [], incomplete: true }
    if (down || !Array.isArray(result?.workspaces)) fail(`Sandbox ${name} cannot be fully inspected: ${down ?? 'invalid workspace inventory'}.`)
    const workspaces = result.workspaces.map(w => ({ ...w, ws: w.workspace, name: String(w.workspace).slice(String(w.workspace).indexOf(':') + 1) }))
    return { ...result, workspaces }
  }
}
