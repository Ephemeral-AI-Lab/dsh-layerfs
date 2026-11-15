#!/usr/bin/env node
// A files read that hangs must hold nothing else up (layerfs-project#178 matrix):
//   F7  an inspection call hangs 60 s while a terminal command and a Commit finish
//       and the machines view answers under 2 s
//
// One page stays on the Sandbox's Files tab, where a folder read hangs; a
// second page of the same browser runs a command in a terminal, commits the
// Workspace, and reads the machines view every 10 s for the 60 s. The Files
// tab must show the wait with its time, then the refusal (the host gives a
// hung read up after 15 s), never an endless "Reading", and read again when
// the hang ends. The log tab's half of F7 is test/e2e-inspect-logs-hang.mjs.
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… INSPECT_SANDBOX=… [INSPECT_STANDIN_DIR=… | INSPECT_HOOK=… INSPECT_FILES_BASE_SANDBOX=…] \
//     node test/e2e-inspect-files-hang.mjs
// Environment, material and what every row also checks: test/e2e-inspect-files-lib.mjs.
import { devUrl } from '../tools/ui.mjs'
import {
  T, baseOf, editor, files, filesDriver, filesSpawns, filesState, forgetPlace, goPath, jump, main, need, openFiles, probe, row, second, setup, shot, sleep, spawnMark, spawns, spawnsSince, under, waitFiles,
} from './e2e-inspect-files-lib.mjs'

const HANG_MS = 60000
const enc = encodeURIComponent
const said = (state) => [...(state?.refusals ?? []), ...(state?.stale ?? [])][0]

setup()
await main('e2e-inspect-files-hang', async ({ run, page, browser }) => {
  await forgetPlace(page)
  await run.row('F7', 'a files read hangs 60 s while a terminal command and a Commit finish and the machines view answers under 2 s', async (t) => {
    const sb = need(T.sandbox)
    const base = baseOf(sb)
    const info = await probe(page, 'GET', `/api/sandboxes/${enc(sb.name)}`)
    if (!info.ok) throw new Error(`GET the Sandbox: ${info.status} ${info.code} ${info.message}`)
    t.check((info.body.workspaces ?? []).length > 0, 'the Sandbox has a Workspace')

    // page A: the Files tab, in the material folder
    await openFiles(page, sb)
    await goPath(page, base)
    // page B: the same Sandbox's terminals
    const b = await second(browser, devUrl())
    run.watch(b.page, b.logs)
    await jump(b.page, sb.title)
    await editor(b.page).getByRole('tab', { name: 'Terminals', exact: true }).click()
    const input = editor(b.page).locator('[data-term-input]').first()
    await input.waitFor({ timeout: 20000 })

    const mark = spawnMark()
    filesDriver.hang(sb, HANG_MS)
    const h0 = Date.now()
    const folder = `${base}/sub`
    await row(page, folder).click()
    let got = await waitFiles(page, (s) => s.reading.some((x) => x.path === folder && /Reading… \d+ s/.test(x.text)), { timeout: 5000 })
    t.check(got.ok && /Cancel/.test(got.state.reading[0].text), `the hung read shows its time and Cancel after 1 s ("${got.state?.reading[0]?.text}")`)
    if (spawns()) t.check(filesSpawns(spawnsSince(mark)).length === 1, 'one files read is hanging')

    const views = []
    const view = async () => { const r = await probe(b.page, 'GET', '/api/machines'); views.push(Math.round(r.ms)); t.check(r.ok && r.ms < 2000, `the machines view answers in under 2 s while the files read hangs (${Math.round(r.ms)} ms, ${Date.now() - h0} ms in)`) }
    await view()

    // a terminal command
    const word = `f7-files-${Date.now().toString(36)}`
    let c0 = Date.now()
    await input.click()
    await input.fill(`echo ${word} > ${word}.txt && cat ${word}.txt`)
    await input.press('Enter')
    await editor(b.page).locator('pre', { hasText: word }).first().waitFor({ timeout: 20000 }).catch(() => t.check(false, 'the terminal command did not finish while the files read hangs'))
    t.note(`terminal command finished ${Date.now() - c0} ms after Enter (${Date.now() - h0} ms into the hang)`)

    // a Commit
    c0 = Date.now()
    await editor(b.page).locator('section[aria-label^="Command for "]').first().getByRole('button', { name: /^More for / }).click()
    await b.page.getByRole('menuitem', { name: 'Commit…' }).click()
    const message = b.page.getByRole('textbox', { name: 'Commit message' })
    await message.fill(`e2e F7 files ${word}`)
    await message.press('Enter')
    await editor(b.page).getByText(/^Committed [0-9a-f]+/).first().waitFor({ timeout: 30000 }).catch(() => t.check(false, 'the Commit did not finish while the files read hangs'))
    t.note(`Commit finished ${Date.now() - c0} ms after the menu was opened (${Date.now() - h0} ms into the hang)`)
    t.check(Date.now() - h0 < HANG_MS, 'both finished inside the hang')
    await shot(b.page, 'inspect-files-f7-terminal')

    // page A: the hung read is given up and shown as a refusal
    got = await waitFiles(page, (s) => !!said(s) && !s.reading.some((x) => x.path === folder), { timeout: Math.max(1000, 26000 - (Date.now() - h0)) })
    t.check(got.ok, `the Files tab shows the hung read as a refusal, not an endless "Reading" (${JSON.stringify(said(got.state))?.slice(0, 200)}, ${Date.now() - h0} ms in)`)
    t.check(/Read again/.test(said(got.state)?.text ?? ''), 'with "Read again"')
    t.check(!got.state?.busy, 'the tab is no longer aria-busy')
    t.note(`Files tab: \`${said(got.state)?.code}\` shown ${Date.now() - h0} ms into the hang${got.state?.stale.length ? ', over the listing the host had kept' : ''}`)
    await shot(page, 'inspect-files-f7-files')
    // the rest of the Files tab answers nothing new while the lane's reads hang, but the page works: its tabs switch
    await editor(page).getByRole('tab', { name: 'Terminals', exact: true }).click()
    await editor(page).locator('input[data-term-input]').first().waitFor({ timeout: 10000 }).catch(() => t.check(false, 'page A: the Terminals tab does not render during the hang'))
    await editor(page).getByRole('tab', { name: 'Files', exact: true }).click()
    await files(page).waitFor()

    for (const at of [20000, 30000, 40000, 50000, 58000]) {
      const wait = at - (Date.now() - h0)
      if (wait > 0) await sleep(wait)
      await view()
    }
    t.note(`machines view during the hang: ${views.join(', ')} ms`)
    if (spawns()) {
      const made = filesSpawns(spawnsSince(mark))
      t.note(`${made.length} files reads were started in the ${Math.round((Date.now() - h0) / 1000)} s (the tab does not poll)`)
      t.check(made.length <= 4, `the tab does not pile reads up (${made.length})`)
    }

    // the hang ends: Read again lists the folder
    filesDriver.unhang(sb)
    await sleep(Math.max(0, HANG_MS + 500 - (Date.now() - h0)))
    await goPath(page, base)
    await row(page, folder).click()
    let s = await filesState(page)
    if (said(s)) await files(page).getByRole('button', { name: 'Read again', exact: true }).first().click()
    got = await waitFiles(page, (x) => under(x, folder).length > 0 && !said(x), { timeout: 20000 })
    t.check(got.ok, `after the hang the folder reads again (${under(got.state, folder).length} entries, ${JSON.stringify(said(got.state) ?? null)})`)
    s = null
  })
})
