#!/usr/bin/env node
// What the Files tabs show when an entry or a read is not an ordinary one
// (layerfs-project#178 matrix):
//   F9   a Workspace mount shows as a mount and is never entered; listing the folder that holds it never hangs
//   F10  restricted, unreadable and system entries cannot be opened; a link to a missing path falls back to the view's root and says so
//   F11  Sandbox stopped: Home still browsable, Whole filesystem shows `Unavailable`; the Terminals tab is unaffected
//   F12  Whole filesystem (Sandbox): the run folder's config/ and a bound Store show locked and cannot be opened
//   F13  binary file, empty file, empty folder and empty log show their states
//   F15  folder and file reads add no lines to the Logs page
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… INSPECT_SANDBOX=… [INSPECT_WHOLE_MACHINE=… INSPECT_WHOLE_SANDBOX=…] \
//     [INSPECT_STANDIN_DIR=… | INSPECT_HOOK=… INSPECT_FILES_BASE_<TARGET>=…] node test/e2e-inspect-files-states.mjs [--rows F9,…]
// Environment, material and what every row also checks: test/e2e-inspect-files-lib.mjs.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NotRun, T, baseOf, cfg, center, driver, editor, files, filesDriver, filesSpawns, filesState, forgetPlace, goPath, home as lfsHome, main, need, openFiles, openFilesAsLeft, pane, parentPath, probe, probeOp, row, rowOf, setup, shot, showFiles, sleep,
  spawnMark, spawns, spawnsSince, switchView, toggle, track, under, waitFiles, waitPane,
} from './e2e-inspect-files-lib.mjs'

const enc = encodeURIComponent
const callsFile = join(lfsHome, 'trace', 'calls.jsonl')
const callLines = () => { try { return readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
const routeOf = (target) => `/api/${target.kind === 'machine' ? 'machines' : 'sandboxes'}/${enc(target.name)}/files`
const listing = async (page, target, path) => {
  const r = await probe(page, 'GET', `${routeOf(target)}${path === undefined ? '' : `?path=${enc(path)}`}`)
  if (!r.ok) throw new Error(`${routeOf(target)} ${path}: ${r.status} ${r.code} ${r.message}`)
  return r
}
/** A row that is listed and nothing more: no chevron, `aria-disabled`, its tooltip, and neither a click nor Enter reads. */
async function inert(t, page, path, kind, tip) {
  const before = await filesState(page)
  const r = rowOf(before, path)
  if (!t.check(!!r, `${path} is listed`)) return
  t.check(r.kind === kind && r.disabled && r.expanded === null, `${path}: kind ${r.kind}, not expandable, aria-disabled`)
  t.check(tip.test(r.title ?? ''), `${path}: tooltip "${r.title}"`)
  const mark = spawns() ? spawnMark() : null
  await row(page, path).click({ force: true })
  await row(page, path).press('Enter')
  await sleep(350)
  const after = await filesState(page)
  t.check(after.file === before.file && after.rows.length === before.rows.length && after.refusals.length === before.refusals.length && after.state === 'ready', `${path}: a click and Enter open nothing`)
  if (mark !== null) t.check(filesSpawns(spawnsSince(mark)).length === 0, `${path}: and read nothing`)
}

setup()
await main('e2e-inspect-files-states', async ({ run, page }) => {
  await forgetPlace(page)

  await run.row('F9', 'a Workspace mount shows as a mount, is never entered, and its folder lists without a wait', async (t) => {
    const sb = need(T.sandbox)
    // the Sandbox's own roots: one mount per Workspace
    const roots = (await listing(page, sb)).body.entries
    const mounts = roots.filter((e) => e.role === 'workspace')
    t.check(mounts.length > 0 && mounts.every((e) => e.kind === 'mount'), `the Sandbox's Workspace roots are mounts (${mounts.length})`)
    // from the machine: the folder that holds the mounts
    const m = need(T.machine)
    const holder = parentPath(mounts[0].path)
    const answer = await listing(page, m, holder)
    if (answer.body.kind !== 'folder') throw new NotRun(`machine ${m.name} does not read ${holder}: ${answer.body.stale?.code} ${answer.body.stale?.message}`)
    t.check(answer.ms < 2000, `the machine lists ${holder.split('/').slice(-2).join('/')} in ${Math.round(answer.ms)} ms`)
    await openFiles(page, m)
    await goPath(page, holder)
    let s = await filesState(page)
    t.check(s.base === holder && s.rows.length === mounts.length, `the Files tab shows the ${mounts.length} mounts`)
    for (const e of mounts.slice(0, 2)) await inert(t, page, e.path, 'mount', /Mount( \(.+\))?, not entered/)
    await shot(page, 'inspect-files-f9')
    // asked by path, a mount is refused, at once
    const direct = await probe(page, 'GET', `${routeOf(m)}?path=${enc(mounts[0].path)}`)
    t.check(direct.ok && direct.body.kind === 'refused' && direct.ms < 2000, `asked for by its path, the mount is refused at once (${direct.body?.stale?.code}, ${Math.round(direct.ms)} ms)`)
    t.note(cfg.standin ? 'the stand-in never stats a Workspace mount (as the spec says LayerFS does not); the daemon was running' : 'run with the Sandbox\'s daemon stopped to show the same listing then')
    void s
  })

  await run.row('F10', 'restricted, unreadable and system entries cannot be opened; a missing path falls back to the view\'s root and says so', async (t) => {
    const m = need(T.machine)
    // restricted, on the machine without `/`: a Sandbox's record folder, a Store folder
    const roots = (await listing(page, m)).body.entries
    const records = roots.find((e) => e.role === 'sandbox_records'), stores = roots.find((e) => e.role === 'stores')
    await openFiles(page, m)
    if (records && T.sandbox.name) {
      await goPath(page, `${records.path}/${T.sandbox.name}`)
      await inert(t, page, `${records.path}/${T.sandbox.name}/control.json`, 'restricted', /Kept private by LayerFS/)
    } else t.note('no Sandbox records root (or no INSPECT_SANDBOX): control.json was not checked')
    if (stores) {
      // a home also keeps the records of Stores that live on other machines: take a Store folder that holds its database
      const folders = (await listing(page, m, stores.path)).body.entries.filter((e) => e.kind === 'folder')
      let inside = folders[0]
      for (const f of folders) { const got = (await listing(page, m, f.path)).body; if (got.kind === 'folder' && got.entries.some((e) => /store\.sqlite$/.test(e.path))) { inside = f; break } }
      if (inside) {
        await goPath(page, inside.path)
        const s = await filesState(page)
        const db = s.rows.find((r) => /store\.sqlite$/.test(r.key))
        if (db) await inert(t, page, db.key, 'restricted', /Kept private by LayerFS/); else t.note(`no store.sqlite in ${inside.path}`)
      }
    }
    // outside the machine's confines: refused, back at the roots, with the reason
    if (!roots.some((e) => e.path === '/')) {
      await goPath(page, '/etc/hosts')
      const got = await waitFiles(page, (s) => s.notice !== null)
      t.check(got.ok && got.state.base === '' && /InvalidInput/.test(got.state.notice) && /\/etc\/hosts could not be opened/.test(got.state.notice) && /Showing LayerFS folders instead/.test(got.state.notice), `a path outside the LayerFS folders: back at the roots, saying so ("${got.state.notice}")`)
    }
    // unreadable and system, on a machine with `/`
    if (T.wholeMachine.name) {
      const w = T.wholeMachine
      await openFiles(page, w)
      await switchView(page, 'Whole filesystem (/)')
      const top = await filesState(page)
      for (const p of ['/proc', '/sys', '/dev'].filter((p) => rowOf(top, p))) await inert(t, page, p, 'system', /System folder, not entered/)
      const un = top.rows.find((r) => r.kind === 'unreadable')
      if (un) await inert(t, page, un.key, 'unreadable', /Not world-readable/); else t.note('no unreadable entry directly under /')
      await toggle(page, '/etc')
      const etc = await filesState(page)
      if (rowOf(etc, '/etc/shadow')) await inert(t, page, '/etc/shadow', 'unreadable', /Not world-readable/)
      const link = etc.rows.find((r) => r.kind === 'symlink')
      if (link) { await inert(t, page, link.key, 'symlink', /Link to .+, not followed/); t.check(link.text.includes('→'), `a link shows its target only (${link.text})`) }
      await shot(page, 'inspect-files-f10-kinds')
      // typed, such a path is refused and the view says so
      await goPath(page, '/etc/shadow')
      let got = await waitFiles(page, (s) => s.notice !== null)
      t.check(got.ok && got.state.view === 'whole' && got.state.base === '' && /\/etc\/shadow could not be opened \(InvalidInput/.test(got.state.notice) && /Showing \/ instead/.test(got.state.notice), `Go to an unreadable path: back at /, saying so ("${got.state.notice}")`)
      // a link to a path that is not there (a stored place, as "Show in Files" leaves one)
      await page.evaluate(({ name }) => {
        const all = JSON.parse(localStorage.getItem('dsh-layerfs:inspect-files') ?? '{}')
        all[`machine:${name}`] = { view: 'whole', path: '/no/such/place.txt' }
        localStorage.setItem('dsh-layerfs:inspect-files', JSON.stringify(all))
      }, { name: w.name })
      await page.reload({ waitUntil: 'networkidle' })
      await track(page); await center(page)
      await openFilesAsLeft(page, w)
      got = await waitFiles(page, (s) => s.notice !== null, { timeout: 15000 })
      t.check(got.ok && got.state.view === 'whole' && got.state.base === '' && got.state.file === '' && got.state.rows.some((r) => r.key === '/etc'), `a link to a missing path opens the view's root (${got.state?.view} "${got.state?.base}", ${got.state?.rows.length} rows)`)
      t.check(/\/no\/such\/place\.txt could not be opened/.test(got.state?.notice ?? '') && /Showing \/ instead/.test(got.state?.notice ?? ''), `and says so: "${got.state?.notice}"`)
      await shot(page, 'inspect-files-f10-missing')
    } else t.note('INSPECT_WHOLE_MACHINE is not set: unreadable and system entries and the missing link were NOT_RUN')
  })

  await run.row('F11', 'Sandbox stopped: Home still browsable, Whole filesystem shows Unavailable; Terminals unaffected', async (t) => {
    const w = need(T.wholeSandbox)
    const base = baseOf(w)
    filesDriver.stop(w)
    try {
      await openFiles(page, w)
      let s = await filesState(page)
      const home = (await listing(page, w)).body.entries.find((e) => e.role === 'home')
      t.check(s.state === 'ready' && !!rowOf(s, home.path), 'stopped: the Sandbox view still lists its roots')
      let got = await toggle(page, home.path)
      t.check(got.ok && under(got.state, home.path).length > 0 && got.state.refusals.length === 0, `Home opens (${under(got.state, home.path).length} entries)`)
      await goPath(page, `${base}/notes.txt`)
      got = await waitFiles(page, (x) => (x.viewer ?? '').includes('second line of notes'))
      t.check(got.ok, 'and a file in it reads')
      if (s.views.length === 2) {
        await switchView(page, 'Whole filesystem (/)')
        got = await waitFiles(page, (x) => x.refusals.length + x.stale.length > 0, { timeout: 15000 })
        const said = got.state?.refusals[0] ?? got.state?.stale[0]
        t.check(got.ok && got.state.view === 'whole' && said.code === 'Unavailable', `Whole filesystem shows the refusal \`Unavailable\` (${JSON.stringify(said)})`)
        t.check(/Read again/.test(said?.text ?? ''), 'with "Read again"')
        t.note(got.state?.stale.length ? `the listing read before the stop stays under it, marked with its time (${got.state.rows.length} rows)` : 'nothing was read before the stop: no tree, only the refusal')
        await shot(page, 'inspect-files-f11-whole')
        await switchView(page, 'Sandbox')
        got = await waitFiles(page, (x) => x.view === 'layerfs' && x.refusals.length === 0 && (x.viewer ?? '').includes('second line of notes'))
        t.check(got.ok, 'back in the Sandbox view: Home as it was, no refusal')
      } else t.note(`a stopped Sandbox's roots offer no / here: no Whole filesystem view to refuse (${JSON.stringify(s.views)})`)
      await editor(page).getByRole('tab', { name: 'Terminals', exact: true }).click()
      await editor(page).getByRole('button', { name: 'New workspace', exact: true }).first().waitFor({ timeout: 15000 }).catch(() => t.check(false, 'the Terminals tab does not render'))
      t.check((await editor(page).locator('input[data-term-input]').count()) > 0, 'the Terminals tab shows its panes')
      s = null
    } finally { filesDriver.start(w) }
    await showFiles(page)
    if ((await filesState(page)).views.length === 2) {
      await switchView(page, 'Whole filesystem (/)')
      const again = files(page).getByRole('button', { name: 'Read again', exact: true })
      if (await again.count()) await again.first().click()
      const got = await waitFiles(page, (x) => x.view === 'whole' && x.state === 'ready' && x.rows.length > 0 && x.refusals.length === 0, { timeout: 15000 })
      t.check(got.ok, 'started again: Read again lists /')
      await switchView(page, 'Sandbox')
    }
    if (cfg.standin) t.note('the stand-in answers as the spec says a stopped Sandbox does; the real Sandbox kept running')
  })

  await run.row('F12', 'Whole filesystem (Sandbox): the run folder\'s config/ and a bound Store show locked and cannot be opened', async (t) => {
    const w = need(T.wholeSandbox)
    const roots = (await listing(page, w)).body.entries
    if (!roots.some((e) => e.path === '/')) throw new NotRun(`Sandbox ${w.name} offers no Whole filesystem view`)
    const home = roots.find((e) => e.role === 'home'), ws = roots.find((e) => e.role === 'workspace')
    const runFolder = parentPath(home.path)
    await openFiles(page, w)
    await switchView(page, 'Whole filesystem (/)')
    await goPath(page, runFolder)
    let got = await waitFiles(page, (s) => s.base === runFolder && s.rows.length > 0)
    t.check(got.ok, `the run folder is at its own path in the Whole filesystem view (${got.state.rows.length} entries)`)
    await inert(t, page, `${runFolder}/config`, 'restricted', /Kept private by LayerFS/)
    if (rowOf(got.state, `${runFolder}/overlay`)) await inert(t, page, `${runFolder}/overlay`, 'restricted', /Kept private by LayerFS/)
    await shot(page, 'inspect-files-f12-run-folder')
    if (ws) {
      const t0 = Date.now()
      await toggle(page, parentPath(ws.path))
      await inert(t, page, ws.path, 'mount', /Mount( \(.+\))?, not entered/)
      t.check(Date.now() - t0 < 5000, `the folder that holds the Workspace mounts lists without a wait (${Date.now() - t0} ms with the checks)`)
    }
    await goPath(page, `${runFolder}/config`)
    got = await waitFiles(page, (s) => s.notice !== null)
    t.check(got.ok && /config could not be opened \(InvalidInput/.test(got.state.notice), `Go to config/: refused, saying so ("${(got.state.notice ?? '').slice(-120)}")`)
    // a Store bound into the Sandbox
    const store = process.env.INSPECT_BOUND_STORE || (cfg.standin ? join(lfsHome, 'store') : null)
    if (!store) { t.note('INSPECT_BOUND_STORE (the path of a Store folder bound into the Sandbox) is not set: the bound Store was NOT_RUN'); return }
    const inside = (await listing(page, w, store)).body
    const dir = inside.kind === 'folder' ? (inside.entries.some((e) => /store\.sqlite$/.test(e.path)) ? store : inside.entries.find((e) => e.kind === 'folder')?.path) : null
    if (!dir) throw new Error(`the bound Store at ${store} does not list: ${JSON.stringify(inside).slice(0, 200)}`)
    await goPath(page, dir)
    got = await waitFiles(page, (s) => s.base === dir && s.rows.some((r) => /store\.sqlite$/.test(r.key)))
    t.check(got.ok, `the bound Store folder lists at its own path (${got.state.rows.map((r) => `${r.key.split('/').pop()}:${r.kind}`).join(' ')})`)
    for (const r of got.state.rows.filter((x) => /store\.sqlite/.test(x.key))) await inert(t, page, r.key, 'restricted', /Kept private by LayerFS/)
    await shot(page, 'inspect-files-f12-store')
    await switchView(page, 'Sandbox')
  })

  await run.row('F13', 'binary file, empty file, empty folder and empty log show their states', async (t) => {
    const sb = need(T.sandbox)
    const base = baseOf(sb)
    await openFiles(page, sb)
    await goPath(page, base)
    await row(page, `${base}/data.bin`).click()
    let got = await waitFiles(page, (s) => s.file === `${base}/data.bin` && /binary file/.test(s.viewer ?? ''))
    t.check(got.ok && got.state.viewer.trim() === 'binary file, 4096 bytes', `a binary file reads "binary file, N bytes" ("${got.state.viewer?.trim()}")`)
    await shot(page, 'inspect-files-f13-binary')
    await row(page, `${base}/empty.txt`).click()
    got = await waitFiles(page, (s) => s.file === `${base}/empty.txt` && (s.viewer ?? '').trim() === 'Empty file')
    t.check(got.ok, `an empty file reads "Empty file" ("${got.state.viewer?.trim()}")`)
    got = await toggle(page, `${base}/emptydir`)
    got = await waitFiles(page, (s) => s.empty.includes(`${base}/emptydir`))
    t.check(got.ok && under(got.state, `${base}/emptydir`).length === 0, 'an empty folder says it is empty under its row')
    const words = await files(page).locator(`[data-tree-empty=${JSON.stringify(`${base}/emptydir`)}]`).textContent()
    t.check(/empty/i.test(words ?? ''), `("${words}")`)
    await shot(page, 'inspect-files-f13-empty')
    // the empty log, in its tab
    driver.truncate('sandbox', sb.name)
    await editor(page).getByRole('tab', { name: 'Daemon log', exact: true }).click()
    await pane(page).waitFor()
    const log = await waitPane(page, (s) => s.state !== 'reading' && s.lines === 0, { timeout: 15000 })
    const text = await pane(page).innerText()
    t.check(log.ok && /The log is empty/.test(text), `an empty log reads "The log is empty" (state ${log.state?.state}, ${log.state?.lines} lines)`)
  })

  await run.row('F15', 'folder and file reads add no lines to the Logs page', async (t) => {
    const sb = need(T.sandbox)
    const base = baseOf(sb)
    const before = callLines().length
    const mark = spawns() ? spawnMark() : null
    await openFiles(page, sb)
    await goPath(page, base)
    await toggle(page, `${base}/sub`)
    await toggle(page, `${base}/sub/deep`)
    await row(page, `${base}/sub/deep/file.txt`).click()
    await waitFiles(page, (s) => /deep file/.test(s.viewer ?? ''))
    await files(page).getByRole('button', { name: 'Refresh', exact: true }).click()
    await sleep(1200)
    // the machine's tab opens in the view and place it was left at: open the first row that is a folder (in `/` the first row can be a link)
    if (T.machine.name) { await openFiles(page, T.machine); const s = await filesState(page); const first = s.rows.find((r) => r.kind === 'folder' && !r.disabled && !r.more); if (first) await toggle(page, first.key) }
    const added = callLines().slice(before).map((l) => { try { return JSON.parse(l) } catch { return {} } })
    const fromFiles = added.filter((l) => Array.isArray(l.argv) && l.argv[1] === 'files')
    t.check(fromFiles.length === 0, `no call-log line from a files read (${added.length} new lines, ${fromFiles.length} from files)`)
    if (mark !== null) { const made = filesSpawns(spawnsSince(mark)); t.check(made.length >= 5, `while ${made.length} files reads became CLI processes`) }
    const list = await probeOp(page, 'logs.list', { limit: 200 })
    if (!list.ok) throw new Error(`logs.list: ${list.code} ${list.message}`)
    const text = JSON.stringify(list.value)
    t.check(!/"(sandbox|machine)",\s*"files"/.test(text) && !/(sandbox|machine)[ .]files\b/.test(text), `the Logs page's own list (logs.list, ${text.length} bytes) holds no files call`)
  })
})
