#!/usr/bin/env node
// Delete (or list) the project conversations that never started — the empty
// "New session / Not started" rows a New Session leaves behind. Runs the host
// op `sessions.pruneNeverStarted` through the live page's debug API, so it
// uses the same code path the host serves (no files touched by hand).
//
//   node tools/prune-never-started.mjs [--url <url>] [--project <project>] [--apply]
//
// Dry run by default: it prints the candidates and deletes nothing. `--apply`
// performs the deletion. The open conversation is passed as `current`, so it is
// never deleted; the host also keeps every loaded conversation.
// URL: `--url`, else DSH_LAYERFS_URL, else the dev server's url.txt.
// Browser: CHROME_PATH, else system Chrome, else Playwright's bundled Chromium.
import { chromium } from 'playwright-core'
import { existsSync } from 'node:fs'
import { devUrl } from './ui.mjs'

const args = process.argv.slice(2)
const value = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }
const apply = args.includes('--apply')
const project = value('--project')
const url = value('--url') ?? process.env.DSH_LAYERFS_URL ?? devUrl()
const chrome = process.env.CHROME_PATH ?? value('--chrome') ?? (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined)

const browser = await chromium.launch({ ...(chrome ? { executablePath: chrome } : {}), headless: true })
try {
  const page = await browser.newPage()
  await page.addInitScript(() => { try { localStorage.setItem('dsh-layerfs:debug', '1') } catch {} })
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForFunction(() => window.__dshLayerfs, null, { timeout: 60000 })
  const result = await page.evaluate(async ([name, dryRun]) => {
    const api = window.__dshLayerfs
    try {
      const answer = await api.op('sessions.pruneNeverStarted', {
        dryRun,
        ...(name ? { project: name } : {}),
        ...(api.selectedSessionId?.() ? { current: api.selectedSessionId() } : {}),
      })
      return { ok: true, ...answer }
    } catch (error) {
      return { ok: false, code: error.code, message: error.message, detail: error.detail }
    }
  }, [project, !apply])
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
  else if (!apply) console.error(`dry run: ${result.candidates.length} candidate(s), nothing deleted. Re-run with --apply to delete them.`)
} finally {
  await browser.close()
}
