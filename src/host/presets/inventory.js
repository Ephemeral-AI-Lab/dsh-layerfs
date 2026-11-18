/* Read-only CLI inventory shared by preset and environment cleanup. */
const fail = message => { throw new Error(message) }
export class CliInventory {
  constructor(driver) { this.driver = driver }
  async query(argv) { return this.driver.invoke(argv, { read: true }) }
  async inventory(family) {
    const items = []; let page = 0
    do {
      // cs20: switch when the Store and Sandbox packages merge (store/sandbox list still old names and paging).
      const result = await this.query([family, 'list', ...(family === 'machine' ? ['--detail'] : []), ...(family === 'sandbox' ? ['--page-size', '1000', '--page-pos', String(page)] : [])])
      const values = Array.isArray(result) ? result : result?.items
      if (!Array.isArray(values)) fail(`Cannot verify cleanup: invalid ${family} inventory.`)
      // 2.0 machine rows are keyed `machine`; the presets key every row by `name`.
      items.push(...(family === 'machine' ? values.map(row => ({ ...row, name: row.machine })) : values))
      const next = result.next_page_pos ?? null
      if (next !== null && (family !== 'sandbox' || !Number.isInteger(next) || next <= page)) fail(`Cannot verify cleanup: invalid ${family} pagination.`)
      page = next
    } while (page !== null)
    return items
  }
  async sandboxDetails(name, { allowDown = false } = {}) {
    let page = 0, detail; const workspaces = []
    do {
      const result = await this.query(['sandbox', 'get', name, '--page-size', '1000', '--page-pos', String(page)])
      if (result.down_reason && allowDown) return { ...result, workspaces: [], incomplete: true }
      if (result.down_reason || !Array.isArray(result.workspaces)) fail(`Sandbox ${name} cannot be fully inspected: ${result.down_reason ?? 'invalid workspace inventory'}.`)
      detail ??= result; workspaces.push(...result.workspaces)
      const next = result.next_page_pos ?? null
      if (next !== null && (!Number.isInteger(next) || next <= page)) fail(`Cannot inspect ${name}: invalid workspace pagination.`)
      page = next
    } while (page !== null)
    return { ...detail, workspaces }
  }
}
