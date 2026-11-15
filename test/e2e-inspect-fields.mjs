#!/usr/bin/env node
// The Sandbox page's use of the monitoring fields of `sandbox.get`
// (layerfs-project#178 matrix):
//   S1 (fields part)  the changes chip shows the count, its tooltip the overlay file's size; "n of N" from workspace_capacity
//   P2  a second client's `sleep 20` shows as "also running" with program, age and session, then clears
//   P3  "also running" on a Workspace past page 1 is reachable from the toolbar summary
//
// INSPECT_SANDBOX needs at least five Workspaces (four panes a page). The
// second client is the CLI the server pins, run by this script on the same
// LayerFS home with a log tag of its own.
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… INSPECT_SANDBOX=… [INSPECT_STANDIN_DIR=…] node test/e2e-inspect-fields.mjs [--rows S1,P2,P3]
// Environment and what every row also checks: test/e2e-inspect-files-lib.mjs.
import { NotRun, T, cfg, declareFields, editor, jump, main, need, probe, secondClient, shot, sleep } from './e2e-inspect-files-lib.mjs'

const enc = encodeURIComponent
const get = async (page, name) => { const r = await probe(page, 'GET', `/api/sandboxes/${enc(name)}`); if (!r.ok) throw new Error(`GET the Sandbox: ${r.status} ${r.code} ${r.message}`); return r.body }
const paneOf = (page, name) => editor(page).locator('section').filter({ has: page.getByRole('textbox', { name: `Command for ${name}`, exact: true }) }).last()
async function terminals(page, sb) {
  await jump(page, sb.title)
  await editor(page).getByRole('tab', { name: 'Terminals', exact: true }).click().catch(() => {})
  await editor(page).locator('input[data-term-input]').first().waitFor({ timeout: 20000 })
}
const until = async (test, timeout, every = 300) => { for (const end = Date.now() + timeout; ;) { const v = await test(); if (v) return v; if (Date.now() > end) return null; await sleep(every) } }
/** Press the page's own Refresh so the next `sandbox.get` is read now. */
const refresh = (page) => editor(page).getByRole('button', { name: 'Refresh', exact: true }).first().click()

await main('e2e-inspect-fields', async ({ run, page }) => {
  await run.row('S1', 'the changes chip shows the count, its tooltip the overlay file\'s size; "n of N" from workspace_capacity', async (t) => {
    const sb = need(T.sandbox)
    if (cfg.standin) declareFields({})
    await terminals(page, sb)
    const info = await get(page, sb.name)
    if (!('workspaceCapacity' in info)) throw new NotRun('this CLI\'s sandbox.get has no workspace_capacity (a build before the fields)')
    const count = async () => (await editor(page).locator('[data-ws-count]').first().textContent()) ?? ''
    t.check((await count()).includes(`${info.workspaces.length} of ${info.workspaceCapacity}`), `the toolbar reads "${await count()}" (workspace_capacity ${info.workspaceCapacity})`)
    const chips = await editor(page).locator('[data-ws-changes]').evaluateAll((els) => els.map((e) => ({ text: e.textContent, title: e.getAttribute('title'), tone: e.getAttribute('data-tone') })))
    t.check(chips.length > 0 && chips.every((c) => !/\b(B|KB|MB|GB|bytes)\b/.test(c.text)), `the chips show the change count only (${chips.map((c) => c.text).join(' | ')})`)
    const withBytes = info.workspaces.filter((w) => typeof w.overlayBytes === 'number')
    t.check(withBytes.length > 0 && chips.every((c) => /overlay file, grows until unmount/.test(c.title ?? '') && /\d/.test(c.title)), `each chip's tooltip gives the overlay file's size: "${chips[0]?.title}"`)
    t.check(chips.some((c) => /uncommitted|change/.test(c.text)), `a Workspace with changes shows them (${chips.map((c) => c.text).join(' | ')})`)
    await shot(page, 'inspect-fields-s1')
    if (!cfg.standin) { t.note('the stand-in parts (another capacity, overlay_bytes null or absent) were not run on a real build'); return }
    try {
      // another capacity: the field is what is shown, not the constant
      declareFields({ workspace_capacity: 8 })
      await refresh(page)
      t.check(!!(await until(async () => (await count()).includes(`${info.workspaces.length} of 8`), 8000)), `with workspace_capacity 8 the toolbar reads "${await count()}"`)
      // not observed, and an older worker: no tooltip, the chip stays
      for (const [how, config] of [['null (not observed)', { overlay_bytes: 'null' }], ['absent (an older worker)', { overlay_bytes: 'absent', workspace_capacity: 'absent', running: 'absent' }]]) {
        declareFields(config)
        await refresh(page)
        const tips = await until(async () => { const x = await editor(page).locator('[data-ws-changes]').evaluateAll((els) => els.map((e) => e.getAttribute('title'))); return x.length && x.every((v) => !v) ? x : null }, 8000)
        t.check(!!tips, `overlay_bytes ${how}: the chips have no tooltip, and stay (${tips?.length})`)
        if (config.workspace_capacity === 'absent') t.check(!!(await until(async () => / of 16\b/.test(await count()), 8000)), `workspace_capacity absent: "n of N" falls back to 16 ("${await count()}")`)
      }
    } finally { declareFields({}); await refresh(page).catch(() => {}) }
  })

  await run.row('P2', 'a second client\'s sleep 20 shows as "also running" with program, age and session, then clears', async (t) => {
    const sb = need(T.sandbox)
    if (cfg.standin) declareFields({})
    await terminals(page, sb)
    const info = await get(page, sb.name)
    if (!info.workspaces.some((w) => 'running' in w)) throw new NotRun('this CLI\'s sandbox.get has no running (a build before the fields)')
    const ws = info.workspaces[1] ?? info.workspaces[0]
    const pane = paneOf(page, ws.name)
    const also = pane.locator('[data-also-running]')
    t.check((await also.count()) === 0, `${ws.name}: no "also running" line before`)
    // the pane's own command is not "also running"
    const input = pane.locator('input[data-term-input]')
    await input.fill('sleep 4')
    await input.press('Enter')
    const own = await until(async () => { const now = await get(page, sb.name); const r = now.workspaces.find((w) => w.ws === ws.ws)?.running ?? []; return r.length ? r : null }, 6000, 500)
    if (t.check(!!own && own.every((r) => r.own === true), `the pane's own sleep is in running, marked as started here (${JSON.stringify(own?.map((r) => ({ program: r.program, own: r.own })))})`)) {
      await refresh(page)
      await sleep(1200)
      t.check((await also.count()) === 0, 'and the pane does not call it "also running"')
    }
    await until(async () => ((await get(page, sb.name)).workspaces.find((w) => w.ws === ws.ws)?.running ?? []).length === 0, 10000, 500)
    // a second client, with a session's tag
    const session = `e2e-p2-${Date.now().toString(36)}`
    const t0 = Date.now()
    const child = secondClient(ws.ws, 'sleep 20', { tag: `dsh:${session}:r1` })
    let ended = null
    child.on('exit', () => { ended = Date.now() })
    const line = await until(async () => ((await also.count()) ? (await also.textContent()) : null), 25000)
    const seen = Date.now() - t0
    t.check(!!line, `the line appears without a reload (${seen} ms after the second client started; the page reads sandbox.get every 15 s)`)
    t.check(/^Also running: sleep · /.test(line ?? ''), `it names the program: "${line}"`)
    t.check(/^Also running: sleep · \d+(s|m \d+s|m) · /.test(line ?? ''), `and its age, in whole seconds: "${line}"`)
    t.check((line ?? '').includes(session.slice(0, 8)) || /session/.test(line ?? ''), `and the session of its tag (${session}): "${line}"`)
    t.check((await also.getByRole('button').count()) === 0 && /cancelled only where it was started/.test((await also.getAttribute('title')) ?? ''), 'the line is view-only: no button, and its tooltip says where it can be cancelled')
    const summary = editor(page).locator('[data-running-summary]')
    t.check(/1 running · 1 by another client/.test((await summary.textContent().catch(() => '')) ?? ''), `the toolbar summary reads "${await summary.textContent().catch(() => null)}"`)
    await shot(page, 'inspect-fields-p2')
    // then clears, by the page's own reads (every 5 s while a command runs)
    const gone = await until(async () => (await also.count()) === 0, 40000)
    t.check(!!gone && ended !== null, `the line clears when the command ends (${ended ? Date.now() - ended : '?'} ms after it ended, ${Date.now() - t0} ms in all)`)
    t.check((await summary.count()) === 0, 'and so does the toolbar summary')
    try { child.kill() } catch { /* ended */ }
  })

  await run.row('P3', '"also running" on a Workspace past page 1 is reachable from the toolbar summary', async (t) => {
    const sb = need(T.sandbox)
    if (cfg.standin) declareFields({})
    await terminals(page, sb)
    const info = await get(page, sb.name)
    if (!info.workspaces.some((w) => 'running' in w)) throw new NotRun('this CLI\'s sandbox.get has no running (a build before the fields)')
    if (info.workspaces.length < 5) throw new NotRun(`Sandbox ${sb.name} has ${info.workspaces.length} Workspaces: page 2 needs five`)
    const names = await editor(page).locator('input[data-term-input]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    const far = info.workspaces.find((w) => !names.includes(`Command for ${w.name}`))
    if (!t.check(!!far, `a Workspace is past the page shown (${names.length} panes of ${info.workspaces.length})`)) return
    const child = secondClient(far.ws, 'sleep 25', { tag: null })
    try {
      const summary = editor(page).locator('[data-running-summary]')
      const text = await until(async () => ((await summary.count()) ? summary.textContent() : null), 25000)
      t.check(/1 running · 1 by another client/.test(text ?? ''), `the toolbar summary appears while ${far.name} is not on the page: "${text}"`)
      t.check((await summary.evaluate((e) => e.tagName)) === 'BUTTON' && new RegExp(`Show ${far.name}`).test((await summary.getAttribute('aria-label')) ?? (await summary.getAttribute('title')) ?? ''), `it is a button that says where it goes ("${(await summary.getAttribute('aria-label')) ?? (await summary.getAttribute('title'))}")`)
      await summary.click()
      const pane = paneOf(page, far.name)
      await pane.locator('input[data-term-input]').waitFor({ timeout: 8000 }).catch(() => t.check(false, `the summary does not show ${far.name}'s pane`))
      const line = await until(async () => ((await pane.locator('[data-also-running]').count()) ? pane.locator('[data-also-running]').textContent() : null), 8000)
      t.check(/^Also running: sleep · /.test(line ?? '') && /another client/.test(line ?? ''), `its pane, now on the page, has the line: "${line}"`)
      await shot(page, 'inspect-fields-p3')
    } finally { try { child.kill() } catch { /* ended */ } }
  })
})
