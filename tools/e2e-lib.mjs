// Shared browser helpers for end-to-end tests against the dev web UI with the
// scripted fake model (dev/fake-llm). Launch helpers mirror tools/shot.mjs.
import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { devUrl, dismiss } from './ui.mjs'
import { isHostName } from '../src/shared/host-machine.ts'

/**
 * The machine e2e project Stores run on. Unset keeps the web API's default,
 * the host machine (`macos-host` / `linux-host`); set `DSH_E2E_MACHINE=docker`
 * on a computer whose host Sandboxes need root. A sqlite Store's machine is the project's machine, so this is set once
 * where the test makes its Store.
 */
export const E2E_MACHINE = process.env.DSH_E2E_MACHINE ?? null

/**
 * Make a Store for an e2e run. `POST /api/stores` always makes a Store on the host machine;
 * any other machine is named once by the private CLI `store create --machine`
 * (the same LayerFS home the dev server uses). `http` is the calling test's
 * `http(method, path, body)` helper.
 */
export async function createStore(http, name) {
  if (!E2E_MACHINE || isHostName(E2E_MACHINE)) return await http('POST', '/api/stores', { name })
  const devDir = process.env.DSH_LAYERFS_DEV_DIR ?? fileURLToPath(new URL('../.dev', import.meta.url))
  const cli = process.env.DSH_LAYERFS_CLI ?? join(devDir, 'layerfs', 'dsh', 'bin', 'layerfs')
  execFileSync(cli, ['store', 'create', name, '--machine', E2E_MACHINE], { stdio: ['ignore', 'pipe', 'pipe'] })
}

/** System Chrome; CHROME_PATH overrides it (Linux CI, a Playwright install). */
export const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** Launch system Chrome on the dev server (dismissed dialogs, debug flag set). */
export async function openDev({ url = devUrl(), size = '1280x820', headless = true } = {}) {
  const [width, height] = size.split('x').map(Number)
  const browser = await chromium.launch({ executablePath: CHROME, headless })
  const page = await browser.newPage({ viewport: { width, height } })
  await page.addInitScript(() => { try { localStorage.setItem('dsh-layerfs:debug', '1') } catch {} })
  const logs = []
  page.on('console', (m) => { if (m.type() === 'error') logs.push(`[error] ${m.text()}`) })
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.locator('[data-composer-input=true], [role=treeitem]').first().waitFor({ timeout: 30000 })
  await page.waitForTimeout(500)
  await dismiss(page)
  return { browser, page, logs }
}

const selectedSessionId = async (page) => (await page.evaluate(() => window.__dshLayerfs?.selectedSessionId?.())) ?? page.locator('[role=treeitem][data-row-key^="session:"][class*=selected]').first()
  .getAttribute('data-row-key', { timeout: 2000 }).then((k) => k?.replace(/^session:/, '') ?? null, () => null)

/** Texts of the transcript's assistant turns (best effort; text nodes of the conversation pane). */
async function transcriptText(page) {
  return page.evaluate(() => {
    const input = document.querySelector('[data-composer-input=true]')
    const main = input?.closest('main') ?? document.body
    return main.innerText
  })
}

/**
 * Run one agent turn in a fresh session.
 * @param page - a page from {@link openDev}.
 * @param opts.message - composer text (default `bash: echo hello > hello.txt`).
 * @param opts.workspace - sidebar workspace title (default: the first workspace row).
 * @param opts.model - model display name to select when not already selected (default `Fake scripted`).
 * @param opts.approve - `'click'` clicks "Allow once" on approval prompts (default), `'none'` leaves them.
 * @param opts.expect - RegExp the finished turn must show (default /done: \d+ commands|echo: /).
 * @param opts.timeoutMs - turn timeout (default 60000).
 * @param opts.newSession - create a new session first (default true).
 * @returns {{ ok, sessionId, texts, transcript, approvals, error? }}
 */
export async function runTurn(page, opts = {}) {
  const {
    message = 'bash: echo hello > hello.txt', workspace, model = 'Fake scripted', approve = 'click',
    expect = /done: \d+ commands[^\n]*|echo: [^\n]*/, timeoutMs = 60000, newSession = true,
  } = opts
  await dismiss(page)
  if (newSession) {
    const button = workspace
      ? page.locator(`button[aria-label=${JSON.stringify(`New session in ${workspace}`)}]`).first()
      : page.locator('button[aria-label^="New session in "]').first()
    if (!(await button.count())) throw new Error(`no workspace row ${workspace ?? '(any)'}`)
    // The per-row button is hover-revealed; hover its row, then click.
    await button.locator('xpath=ancestor::*[@role="treeitem"][1]').hover({ timeout: 2000 }).catch(() => {})
    await button.click({ force: true })
    await page.waitForTimeout(800)
  }
  const trigger = page.locator('button[aria-label^="Select model, current"]').first()
  if (model && (await trigger.count()) && !((await trigger.getAttribute('aria-label')) ?? '').includes(model)) {
    await trigger.click()
    await page.getByText(model, { exact: true }).last().click()
    await page.locator('[role=menu]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  }
  const pattern = new RegExp(expect.source, expect.flags.replace('g', '') + 'g')
  // Earlier turns of a reused session may already match; require new matches.
  const before = ((await transcriptText(page)).match(pattern) ?? []).length
  const input = page.locator('[data-composer-input=true]').first()
  await input.click()
  const lines = message.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (i) await page.keyboard.press('Shift+Enter')
    await page.keyboard.insertText(lines[i])
  }
  await page.getByRole('button', { name: 'Send message' }).click()
  const deadline = Date.now() + timeoutMs
  let approvals = 0
  let found = null
  while (Date.now() < deadline) {
    if (approve === 'click') {
      const allow = page.getByRole('button', { name: /^Allow once$/ })
      if (await allow.count()) { await allow.first().click(); approvals++; await page.waitForTimeout(300); continue }
    }
    const text = await transcriptText(page)
    const m = text.match(pattern) ?? []
    if (m.length > before && !(await page.getByRole('button', { name: /^Stop(?:\s|$)/ }).count())) { found = m.slice(before); break }
    await page.waitForTimeout(300)
  }
  const sessionId = await selectedSessionId(page)
  const transcript = await transcriptText(page)
  if (!found) return { ok: false, sessionId, texts: [], transcript, approvals, error: `timed out waiting for ${expect}` }
  return { ok: true, sessionId, texts: [...found], transcript, approvals }
}
