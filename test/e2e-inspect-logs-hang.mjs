#!/usr/bin/env node
// A log read that hangs must hold nothing else up (layerfs-project#178 matrix):
//   F7  an inspection call hangs 60 s while a terminal command and a Commit finish
//       and the machines view answers under 2 s
//
// One page stays on the Sandbox's Daemon log tab, whose reads hang; a second
// page of the same browser runs a command in a terminal, commits the
// Workspace, and reads the machines view every 10 s for the 60 s. The log tab
// must show the refusal with the lines it had (the host gives a hung read up
// after 15 s), never an endless "Reading", and read again when the hang ends.
// The Sandbox needs one Workspace; without one the script mounts Branch
// `e2e-f7` (forked from main) as `f7`.
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… INSPECT_SANDBOX=… [INSPECT_STANDIN_DIR=… | INSPECT_HOOK=…] \
//     node test/e2e-inspect-logs-hang.mjs
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs.
import { devUrl } from '../tools/ui.mjs'
import {
  driver, editor, jump, main, needSandbox, newTag, openQuiet, pane, probe, second, seqsOf, shot, showLog, sleep, spawnMark, spawns, spawnsSince, targets, waitPane,
} from './e2e-inspect-logs-lib.mjs'

const HANG_MS = 60000
const enc = encodeURIComponent
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

await main('e2e-inspect-logs-hang', async ({ run, page, browser }) => {
  await run.row('F7', 'a log read hangs 60 s while a terminal command and a Commit finish and the machines view answers under 2 s', async (t) => {
    needSandbox()
    const sb = targets.sandbox, tag = newTag('f7')
    // a Workspace to run in
    let info = await probe(page, 'GET', `/api/sandboxes/${enc(sb.name)}`)
    if (!info.ok) throw new Error(`GET the Sandbox: ${info.status} ${info.code} ${info.message}`)
    if (!(info.body.workspaces ?? []).length) {
      const mounted = await probe(page, 'POST', `/api/sandboxes/${enc(sb.name)}/workspaces`, { branch: 'e2e-f7', fork: true, name: 'f7' })
      if (!mounted.ok) throw new Error(`mount a Workspace: ${mounted.status} ${mounted.code} ${mounted.message}`)
      info = await probe(page, 'GET', `/api/sandboxes/${enc(sb.name)}`)
      t.note('mounted Workspace f7 on Branch e2e-f7 (forked from main)')
    }
    t.check((info.body.workspaces ?? []).length > 0, 'the Sandbox has a Workspace')

    // page A: the Daemon log, shown before the hang
    await openQuiet(page, sb)
    driver.fill('sandbox', sb.name, 30, tag)
    await showLog(page, sb)
    let got = await waitPane(page, (s) => s.state === 'ready' && seqsOf(s.rows, tag).length === 30)
    t.check(got.ok, 'the daemon log is shown before the hang')
    // page B: the same Sandbox's terminals
    const b = await second(browser, devUrl())
    run.watch(b.page, b.logs)
    await jump(b.page, sb.title)
    await editor(b.page).getByRole('tab', { name: 'Terminals', exact: true }).click()
    const input = editor(b.page).locator('[data-term-input]').first()
    await input.waitFor({ timeout: 20000 })

    const mark = spawnMark()
    driver.hang('sandbox', sb.name, HANG_MS)
    const h0 = Date.now()
    // the next poll hangs: wait until its process is there
    if (spawns()) {
      for (const until = Date.now() + 12000; Date.now() < until && spawnsSince(mark).inspect.length === 0;) await sleep(200)
      t.check(spawnsSince(mark).inspect.length >= 1, 'a log read is hanging')
    } else await sleep(4500)

    const views = []
    const view = async () => { const r = await probe(b.page, 'GET', '/api/machines'); views.push(Math.round(r.ms)); t.check(r.ok && r.ms < 2000, `the machines view answers in under 2 s while the log read hangs (${Math.round(r.ms)} ms, ${Date.now() - h0} ms in)`) }
    await view()

    // a terminal command
    const word = `f7-${tag}`
    let c0 = Date.now()
    await input.click()
    await input.fill(`echo ${word} > ${word}.txt && cat ${word}.txt`)
    await input.press('Enter')
    const out = editor(b.page).locator('pre', { hasText: word }).first()
    await out.waitFor({ timeout: 20000 }).catch(() => t.check(false, 'the terminal command did not finish while the log read hangs'))
    const commandMs = Date.now() - c0
    t.note(`terminal command finished ${commandMs} ms after Enter (${Date.now() - h0} ms into the hang)`)

    // a Commit
    c0 = Date.now()
    await editor(b.page).locator('section[aria-label^="Command for "]').first().getByRole('button', { name: /^More for / }).click()
    await b.page.getByRole('menuitem', { name: 'Commit…' }).click()
    const message = b.page.getByRole('textbox', { name: 'Commit message' })
    await message.fill(`e2e F7 ${tag}`)
    await message.press('Enter')
    await editor(b.page).getByText(/^Committed [0-9a-f]+/).first().waitFor({ timeout: 30000 }).catch(() => t.check(false, 'the Commit did not finish while the log read hangs'))
    const commitMs = Date.now() - c0
    t.note(`Commit finished ${commitMs} ms after the menu was opened (${Date.now() - h0} ms into the hang)`)
    t.check(Date.now() - h0 < HANG_MS, 'both finished inside the hang')
    await shot(b.page, 'inspect-logs-f7-terminal')

    // page A: the hung read is given up and shown as a refusal over the lines it had
    got = await waitPane(page, (s) => s.stale !== null, { timeout: Math.max(1000, 26000 - (Date.now() - h0)) })
    t.check(got.ok && got.state.state === 'stale', `the log tab shows the hung read as a refusal, not an endless "Reading" (state ${got.state?.state}, stale ${got.state?.stale}, ${Date.now() - h0} ms in)`)
    t.check(same(seqsOf(got.state?.rows ?? [], tag), range(0, 29)) && /showing lines read at/.test(got.state?.staleText ?? ''), `its lines stay, with their time: "${got.state?.staleText}"`)
    t.check((await pane(page).locator('[data-log-stale]').getByRole('button', { name: /^Read/ }).count()) === 1, 'with "Read again"')
    t.note(`log tab: \`${got.state?.stale}\` shown ${Date.now() - h0} ms into the hang`)
    await shot(page, 'inspect-logs-f7-log')

    // the machines view through the rest of the 60 s
    for (const at of [20000, 30000, 40000, 50000, 58000]) {
      const wait = at - (Date.now() - h0)
      if (wait > 0) await sleep(wait)
      await view()
    }
    t.note(`machines view during the hang: ${views.join(', ')} ms`)
    if (spawns()) {
      const made = spawnsSince(mark)
      t.note(`${made.inspect.length} hung log reads were started in the ${Math.round((Date.now() - h0) / 1000)} s (each given up after 15 s; the tab backs off to 10 s between them)`)
      t.check(made.inspect.length <= 6, `the tab does not pile reads up (${made.inspect.length})`)
    }

    // the hang ends: the tab reads again
    driver.unhang('sandbox', sb.name)
    driver.append('sandbox', sb.name, 30, 2, tag)
    got = await waitPane(page, (s) => s.state === 'ready' && seqsOf(s.rows, tag).length === 32, { timeout: 30000 })
    t.check(got.ok, `after the hang the tab reads on by itself (state ${got.state?.state}, stale ${got.state?.stale}, ${seqsOf(got.state?.rows ?? [], tag).length} lines)`)
  })
})
