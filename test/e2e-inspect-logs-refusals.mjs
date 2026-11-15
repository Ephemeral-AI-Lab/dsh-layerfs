#!/usr/bin/env node
// Refused log reads in a browser (layerfs-project#178 matrix):
//   F3              Sandbox lost or unresolved: the Daemon log tab shows the refusal; the page and its other tab work
//   F5 (log part)   refusal codes shown: a stale cursor (`InvalidInput`), the inspect lane's `Busy` with "Read again"
//   F4 (log part)   `sandbox.get` hangs: the head and tabs render and the Daemon log works; only Terminals waits
//
// F3 with a Sandbox that really is lost: name it in INSPECT_LOST_SANDBOX (its
// page must show state lost or gone). The stand-in cannot lose a Sandbox; it
// refuses the log call instead (`unresolved`).
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… INSPECT_SANDBOX=… [INSPECT_STANDIN_DIR=… | INSPECT_HOOK=…] [INSPECT_LOST_SANDBOX=…] \
//     node test/e2e-inspect-logs-refusals.mjs [--rows F3,F5,F4]
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs.
import {
  NotRun, cfg, center, driver, editor, jump, main, needSandbox, newTag, openQuiet, outside, pane, primary, probe, probeOp, seqsOf, setHidden, shot, showLog, sleep, spawnMark, spawns, spawnsSince, tabs, targets, track, waitPane,
} from './e2e-inspect-logs-lib.mjs'

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
const enc = encodeURIComponent
const readAgain = (page) => pane(page).locator('[data-log-stale]').getByRole('button', { name: 'Read again', exact: true })

await main('e2e-inspect-logs-refusals', async ({ run, page, browser }) => {
  await run.row('F3', 'Sandbox lost or unresolved: the tab shows the refusal', async (t) => {
    let ran = 0
    const skipped = []
    // unresolved: the log call is refused while the tab follows the log
    try {
      needSandbox()
      const sb = targets.sandbox, tag = newTag('f3')
      await openQuiet(page, sb)
      driver.fill('sandbox', sb.name, 20, tag)
      await showLog(page, sb)
      let got = await waitPane(page, (s) => s.state === 'ready' && seqsOf(s.rows, tag).length === 20)
      t.check(got.ok, 'the daemon log is shown before the refusal')
      const message = `no Sandbox named ${sb.name}`
      driver.refuse('sandbox', sb.name, 'NoSuchSandbox', message)
      ran++
      got = await waitPane(page, (s) => s.stale === 'NoSuchSandbox', { timeout: 15000 })
      t.check(got.ok, `the tab shows the refusal's code (stale ${got.state?.stale})`)
      t.check(got.state.staleText.includes('NoSuchSandbox') && got.state.staleText.includes(message), `…and its words: "${got.state.staleText}"`)
      t.check(/showing lines read at/.test(got.state.staleText) && same(seqsOf(got.state.rows, tag), range(0, 19)), 'the lines read before stay, with the time they were read')
      t.check(got.state.status === 'Stopped reading', `a Sandbox that cannot be found is not polled on (status "${got.state.status}")`)
      t.check((await readAgain(page).count()) === 1, 'the refusal has "Read again"')
      t.check(same(await tabs(page), ['Terminals', 'Daemon log']), 'the tabs are still there')
      await shot(page, 'inspect-logs-f3')
      if (spawns()) {
        const mark = spawnMark()
        await sleep(6000)
        t.check(spawnsSince(mark).inspect.length === 0, `no log read in the 6 s after it stopped (${spawnsSince(mark).inspect.length})`)
      }
      // the rest of the page works, and coming back shows the refusal again, never an endless "Reading"
      await editor(page).getByRole('tab', { name: 'Terminals', exact: true }).click()
      await editor(page).getByRole('button', { name: 'New workspace', exact: true }).first().waitFor({ timeout: 10000 }).catch(() => t.check(false, 'Terminals does not render while the log is refused'))
      await editor(page).getByRole('tab', { name: 'Daemon log', exact: true }).click()
      got = await waitPane(page, (s) => s.state !== 'reading', { timeout: 10000 })
      t.check(got.ok && got.state.stale === 'NoSuchSandbox', `reopened: the refusal again (state ${got.state?.state}, stale ${got.state?.stale})`)
      t.check(same(seqsOf(got.state.rows, tag), range(0, 19)), 'reopened: the host\'s last good lines are shown under it')
      driver.unrefuse('sandbox', sb.name)
      await readAgain(page).click()
      got = await waitPane(page, (s) => s.state === 'ready' && /^Following/.test(s.status), { timeout: 10000 })
      t.check(got.ok && same(seqsOf(got.state.rows, tag), range(0, 19)), `"Read again" reads it once the Sandbox answers (state ${got.state?.state}, status "${got.state?.status}")`)

      // a refusal that can pass: the tab keeps polling and recovers by itself
      driver.refuse('sandbox', sb.name, 'Unavailable', 'the daemon did not answer')
      got = await waitPane(page, (s) => s.stale === 'Unavailable', { timeout: 15000 })
      t.check(got.ok && got.state.status === 'Last read failed' && same(seqsOf(got.state.rows, tag), range(0, 19)), `Unavailable: lines kept, still polling (stale ${got.state?.stale}, status "${got.state?.status}")`)
      driver.unrefuse('sandbox', sb.name)
      driver.append('sandbox', sb.name, 20, 2, tag)
      got = await waitPane(page, (s) => s.state === 'ready' && seqsOf(s.rows, tag).length === 22, { timeout: 15000 })
      t.check(got.ok, `it recovers without a click and shows the new lines (state ${got.state?.state}, ${seqsOf(got.state.rows, tag).length} lines)`)
    } catch (error) { if (!(error instanceof NotRun)) throw error; skipped.push(`unresolved: ${error.message}`) }

    // lost: a Sandbox whose state is lost or gone
    const lost = process.env.INSPECT_LOST_SANDBOX
    if (lost) {
      ran++
      // the stand-in knows nothing of a Sandbox's state: there the log call is made to refuse as well; a real build answers by itself
      let injected = false
      try { driver.refuse('sandbox', lost, 'Unavailable', `Sandbox ${lost} is lost: its daemon is not running`); injected = true } catch (error) { if (!(error instanceof NotRun)) throw error }
      await jump(page, lost)
      t.check(((await editor(page).getByRole('heading', { level: 1 }).first().textContent()) ?? '').includes(lost), 'lost Sandbox: the head renders')
      const names = await tabs(page)
      t.check(same(names, ['Terminals', 'Daemon log']), `lost Sandbox: tabs ${JSON.stringify(names)}`)
      await editor(page).getByRole('tab', { name: 'Daemon log', exact: true }).click()
      let got = await waitPane(page, (s) => s.state !== 'reading', { timeout: 20000 })
      t.check(got.ok, 'lost Sandbox: the log tab answers, never an endless "Reading"')
      if (got.state?.stale) {
        // any refusal ends polling once the page knows the Sandbox is lost (sandbox.get's state)
        got = await waitPane(page, (s) => s.status === 'Stopped reading', { timeout: 25000 })
        t.check(got.ok && (await readAgain(page).count()) === 1, `lost Sandbox: the refusal is shown with "Read again" and is not polled on (status "${got.state?.status}")`)
        t.note(`lost Sandbox ${lost}: logs.sandbox refused \`${got.state?.stale}\`${injected ? ' (made to by this script: the stand-in cannot tell a lost Sandbox)' : ''}: "${got.state?.staleText}"`)
        if (spawns()) {
          const mark = spawnMark()
          await sleep(5000)
          t.check(spawnsSince(mark).inspect.length === 0, `lost Sandbox: no log read in the 5 s after it stopped (${spawnsSince(mark).inspect.length})`)
        }
      } else t.note(`lost Sandbox ${lost}: logs.sandbox still answers (${got.state?.lines} lines): its log file can be read without the daemon`)
      await editor(page).getByRole('tab', { name: 'Terminals', exact: true }).click()
      await pane(page).waitFor({ state: 'detached' })
      t.check((await editor(page).locator('[data-sandbox-terminals]').count()) === 1, 'lost Sandbox: the Terminals tab still opens')
      await shot(page, 'inspect-logs-f3-lost')
      if (injected) driver.unrefuse('sandbox', lost)
    } else skipped.push('lost: INSPECT_LOST_SANDBOX is not set (a Sandbox in state lost or gone)')
    for (const s of skipped) t.note(`not run — ${s}`)
    if (!ran) throw new NotRun(skipped.join('; '))
  })

  await run.row('F5', 'refusal codes shown: stale cursor; inspect lane Busy with Read again (log part)', async (t) => {
    const target = await primary(page), tag = newTag('f5')
    const path = target.kind === 'machine' ? `/api/machines/${enc(target.name)}/log` : `/api/sandboxes/${enc(target.name)}/log`
    await openQuiet(page, target)
    driver.fill(target.kind, target.name, 300, tag)
    const tail = await probe(page, 'GET', path)
    t.check(tail.ok && tail.body.stale === false && !!tail.body.cursor && !!tail.body.before, `the route answers a tail with a cursor and a before (${tail.status})`)
    await showLog(page, target)
    let got = await waitPane(page, (s) => s.state === 'ready' && seqsOf(s.rows, tag).length === 200 && s.earlier)
    t.check(got.ok, 'the log is shown with "Earlier lines"')

    // the log is rotated while the page does not poll (hidden), so the stale `before` is what the page asks with
    await setHidden(page, true)
    await sleep(1200)
    driver.rotate(target.kind, target.name)
    driver.append(target.kind, target.name, 300, 5, tag)
    const forward = await probe(page, 'GET', `${path}?cursor=${enc(tail.body.cursor)}`)
    t.check(forward.ok && forward.body.stale?.code === 'InvalidInput' && forward.body.lines.length === 0, `route, stale cursor: 200 with stale.code InvalidInput and no lines (${forward.status} ${JSON.stringify(forward.body?.stale ?? forward.code)})`)
    const back = await probe(page, 'GET', `${path}?before=${enc(tail.body.before)}`)
    t.check(back.ok && back.body.stale?.code === 'InvalidInput', `route, stale before: 200 with stale.code InvalidInput (${back.status} ${JSON.stringify(back.body?.stale ?? back.code)})`)
    const both = await probe(page, 'GET', `${path}?cursor=a&before=b`)
    t.check(!both.ok && both.status === 400 && both.code === 'InvalidInput', `route, cursor and before together: 400 InvalidInput (${both.status} ${both.code})`)
    await pane(page).locator('[data-log-earlier]').click()
    got = await waitPane(page, (s) => s.stale === 'InvalidInput', { timeout: 10000 })
    t.check(got.ok && got.state.staleText.includes('InvalidInput'), `"Earlier lines" with the stale cursor shows the code: "${got.state?.staleText}"`)
    t.check((await readAgain(page).count()) === 1, '…with "Read again"')
    t.check(!got.state.earlier && got.state.cut && same(seqsOf(got.state.rows, tag), range(100, 299)), 'the lines shown stay; the lines before them are no longer offered')
    await shot(page, 'inspect-logs-f5-stale-cursor')
    await setHidden(page, false)
    got = await waitPane(page, (s) => s.rows.includes('---') && seqsOf(s.rows, tag).at(-1) === 304, { timeout: 15000 })
    t.check(got.ok && got.state.stale === null, `following again: the stale forward cursor becomes the "log replaced" divider, not an error (stale ${got.state?.stale})`)

    // Busy: 2 reads run, 4 wait, the next is refused at once. The six come from three other
    // clients, two each: one page cannot hold six host requests open (see `outside`).
    await openQuiet(page, target)
    const clients = [await outside(browser), await outside(browser), await outside(browser)]
    const mark = spawnMark()
    driver.hang(target.kind, target.name, 60000)
    const rids = range(0, 5).map((i) => `e2e-busy-${tag}-${i}`)
    for (const [c, client] of clients.entries()) {
      await client.evaluate(({ path, rids, c }) => {
        window.__busy = [0, 1].map((i) => window.__dshLayerfs.call('GET', `${path}?limit=${11 + c * 2 + i}&rid=${rids[c * 2 + i]}`).then((v) => ({ answered: v.stale ? v.stale.code : 'lines' }), (e) => ({ refused: e?.code ?? null, status: e?.status ?? null })))
      }, { path, rids, c })
      await sleep(300) // in order: the first client's two run, the others' four wait
    }
    await editor(page).getByRole('tab', { name: target.tab, exact: true }).click()
    got = await waitPane(page, (s) => s.stale === 'Busy', { timeout: 8000 })
    t.check(got.ok, `with the lane full the tab's read is refused Busy at once (state ${got.state?.state}, stale ${got.state?.stale})`)
    t.check(!!got.state?.staleText.includes('Busy') && (await readAgain(page).count()) === 1, `Busy is shown with "Read again": "${got.state?.staleText}"`)
    t.check(got.state?.status !== 'Stopped reading', `Busy does not end polling (status "${got.state?.status}")`)
    await shot(page, 'inspect-logs-f5-busy')
    if (spawns()) t.check(spawnsSince(mark).inspect.length === 2, `2 processes for 6 waiting reads and 1 refused (${spawnsSince(mark).inspect.length})`)
    // the clients' six reads are dropped: the queued leave without a process, the running end
    const dropped = []
    for (const rid of rids) dropped.push((await probeOp(page, 'inspect.cancel', { rid })).value?.cancelled === true)
    t.check(dropped.every(Boolean), `inspect.cancel drops each of the six (${dropped.filter(Boolean).length})`)
    const ends = (await Promise.all(clients.map((client) => client.evaluate(() => Promise.all(window.__busy))))).flat()
    t.check(ends.every((e) => e.refused === 'Cancelled'), `each dropped read ends Cancelled (${JSON.stringify(ends)})`)
    if (spawns()) {
      const limits = spawnsSince(mark).inspect.filter((s) => s.argv.includes('--limit')).map((s) => Number(s.argv[s.argv.indexOf('--limit') + 1]))
      t.check(limits.filter((n) => n >= 13 && n <= 16).length === 0, `the four queued reads never became a process (limits spawned: ${limits.join(',')})`)
    }
    for (const client of clients) await client.context().close()
    driver.unhang(target.kind, target.name)
    await readAgain(page).click()
    got = await waitPane(page, (s) => s.state === 'ready' && s.stale === null, { timeout: 10000 })
    t.check(got.ok, `"Read again" reads the log once the lane is free (state ${got.state?.state}, stale ${got.state?.stale})`)
    t.note('escaping path and FIFO are refusals of the files calls: not part of the log step')
  })

  await run.row('F4', '`sandbox.get` hangs: head and tabs render; Daemon log works (log part)', async (t) => {
    needSandbox()
    const sb = targets.sandbox, tag = newTag('f4'), HANG_MS = 30000
    await jump(page, cfg.machineTitle)
    driver.fill('sandbox', sb.name, 30, tag)
    // a page that has never read this Sandbox
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('[data-composer-input=true], [role=treeitem]').first().waitFor({ timeout: 30000 })
    await track(page)
    await center(page)
    driver.hangGet(sb.name, HANG_MS)
    const h0 = Date.now()
    await page.evaluate((path) => { window.__get = 'pending'; window.__inspect.raw.call('GET', path).then(() => { window.__get = 'answered' }, (e) => { window.__get = `refused ${e?.code}` }) }, `/api/sandboxes/${enc(sb.name)}`)
    await jump(page, sb.title)
    t.check(((await editor(page).getByRole('heading', { level: 1 }).first().textContent()) ?? '').includes(sb.name), 'the head renders from the list row')
    t.check(same(await tabs(page), ['Terminals', 'Daemon log']), `the tabs render: ${JSON.stringify(await tabs(page))}`)
    t.note(`head and tabs shown ${Date.now() - h0} ms after sandbox.get began to hang`)
    await editor(page).getByRole('tab', { name: 'Terminals', exact: true }).click()
    const terminals = editor(page).locator('[data-sandbox-terminals]')
    await terminals.getByText('Reading the Sandbox…').first().waitFor({ timeout: 5000 }).catch(() => t.check(false, 'Terminals does not say it is reading the Sandbox'))
    t.check((await terminals.locator('[data-term-input]').count()) === 0, 'only the Terminals tab waits on sandbox.get')
    const l0 = Date.now()
    await editor(page).getByRole('tab', { name: 'Daemon log', exact: true }).click()
    const got = await waitPane(page, (s) => s.state === 'ready' && seqsOf(s.rows, tag).length === 30, { timeout: 10000 })
    t.check(got.ok, `the Daemon log reads while sandbox.get hangs (state ${got.state?.state}, ${got.state?.lines} lines, ${Date.now() - l0} ms)`)
    const state = await page.evaluate(() => window.__get)
    t.check(state === 'pending', `sandbox.get was still hanging then (${state}, ${Date.now() - h0} ms in)`)
    await shot(page, 'inspect-logs-f4')
    // the hang ends: Terminals renders
    driver.unhangGet(sb.name)
    await editor(page).getByRole('tab', { name: 'Terminals', exact: true }).click()
    const again = terminals.getByRole('button', { name: 'Try again', exact: true })
    const ready = terminals.getByRole('button', { name: 'New workspace', exact: true }).first()
    const left = Math.max(5000, HANG_MS - (Date.now() - h0) + 15000)
    await ready.or(again).first().waitFor({ timeout: left }).catch(() => {})
    if (await again.count()) { t.note('Terminals showed the failed read with "Try again" (the hung read was given up)'); await again.click() }
    await ready.waitFor({ timeout: 20000 }).catch(() => t.check(false, 'Terminals does not render after the hang ended'))
    t.note(`Terminals rendered ${Date.now() - h0} ms after the hang began`)
    t.note('"Home still works" is the Files tab: not part of the log step. The lost-Sandbox half is F3 with INSPECT_LOST_SANDBOX')
  })
})
