#!/usr/bin/env node
// The Worker log and Daemon log tabs in a browser (layerfs-project#178 matrix):
//   S1 (logs part)  logs show and follow; find, wrap, copy; the links to the log tab; the last tab is kept
//   P1              a 5,000-line log loads by cursor; "Earlier lines" pages back to the start; the page stays responsive
//   P5              a rotation while polling: a "log replaced" divider, no line twice
//   F13 (log part)  an empty log shows its state, then follows
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… INSPECT_SANDBOX=… [INSPECT_STANDIN_DIR=… | INSPECT_HOOK=…] \
//     node test/e2e-inspect-logs.mjs [--rows S1,P1] [--shots <dir>] [--headed]
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs.
import {
  cfg, driver, editor, hasTab, jump, main, needSandbox, newTag, offered, openLog, openQuiet, pane, paneState, primary, seqsOf, shot, showLog, spawnMark, spawns, spawnsSince, tabs, targets, waitPane,
} from './e2e-inspect-logs-lib.mjs'

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
const brief = (list) => (list.length > 12 ? `${list.slice(0, 5).join(',')} … ${list.slice(-5).join(',')} (${list.length})` : list.join(','))

await main('e2e-inspect-logs', async ({ run, page }) => {
  await run.row('S1', 'logs show and follow (logs part)', async (t) => {
    needSandbox()
    const has = await offered(page)
    const sb = targets.sandbox, tag = newTag('s1')
    t.check(has.sandboxLog, 'the CLI has logs.sandbox')
    await openQuiet(page, sb)
    driver.fill('sandbox', sb.name, 120, tag)
    t.check(same((await tabs(page)).filter((x) => x !== 'Files'), ['Terminals', 'Daemon log']), `Sandbox tabs: ${JSON.stringify(await tabs(page))}`)
    await showLog(page, sb)
    let got = await waitPane(page, (s) => s.state === 'ready' && seqsOf(s.rows, tag).length === 120)
    t.check(got.ok, `the daemon log shows the 120 lines written (state ${got.state?.state}, ${got.state?.lines} lines)`)
    t.check(same(seqsOf(got.state.rows, tag), range(0, 119)), `lines in order, each once: ${brief(seqsOf(got.state.rows, tag))}`)
    t.check(/^Following/.test(got.state.status), `status: "${got.state.status}"`)
    t.check(got.state.atBottom, 'the pane opens at the newest line')
    t.check((await pane(page).getByRole('log').getAttribute('aria-label')) === `Daemon log of ${sb.name}`, 'the scroller is named for the Sandbox')
    await shot(page, 'inspect-logs-s1-daemon')

    // follows while at the bottom
    driver.append('sandbox', sb.name, 120, 3, tag)
    got = await waitPane(page, (s) => seqsOf(s.rows, tag).length === 123, { timeout: 12000 })
    t.check(got.ok && same(seqsOf(got.state.rows, tag), range(0, 122)), `3 new lines appear without a reload: ${brief(seqsOf(got.state.rows, tag))}`)
    t.check(got.state.atBottom && got.state.jump === null, 'still at the bottom, no "new lines" button')

    // scrolled up: the new lines are counted, not jumped to
    await page.evaluate(() => { const el = [...document.querySelectorAll('[data-log-scroll]')].find((e) => e.offsetParent); el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
    driver.append('sandbox', sb.name, 123, 2, tag)
    got = await waitPane(page, (s) => s.jump !== null && seqsOf(s.rows, tag).length === 125, { timeout: 12000 })
    t.check(got.ok && /2 new lines/.test(got.state.jump ?? ''), `scrolled up: "${got.state.jump}" (want "↓ 2 new lines")`)
    t.check(!got.state.atBottom, 'the reader\'s place is kept')
    await pane(page).locator('[data-log-jump]').click()
    got = await waitPane(page, (s) => s.atBottom && s.jump === null, { timeout: 3000 })
    t.check(got.ok, 'the button goes to the newest line and leaves')

    // find in loaded lines
    const find = pane(page).getByRole('textbox', { name: 'Find in loaded lines' })
    await find.fill(`${tag} 000041`)
    await pane(page).getByText('1 of 1', { exact: true }).waitFor({ timeout: 3000 }).catch(() => t.check(false, 'find: no "1 of 1"'))
    t.check((await pane(page).locator('mark').allTextContents()).join('|') === `${tag} 000041`, `find marks the match: ${JSON.stringify(await pane(page).locator('mark').allTextContents())}`)
    await find.fill(tag.toUpperCase())
    await pane(page).getByText('1 of 125', { exact: true }).waitFor({ timeout: 3000 }).catch(() => t.check(false, 'find ignores case: no "1 of 125"'))
    await find.press('Enter')
    await pane(page).getByText('2 of 125', { exact: true }).waitFor({ timeout: 3000 }).catch(() => t.check(false, 'Enter goes to the next match'))
    await find.fill('no-such-text-anywhere')
    await pane(page).getByText('No match', { exact: true }).waitFor({ timeout: 3000 }).catch(() => t.check(false, 'find: no "No match"'))
    await find.press('Escape')
    t.check((await find.inputValue()) === '', 'Escape clears the find box')

    // wrap and copy
    const wrap = pane(page).getByRole('button', { name: 'Wrap', exact: true })
    const was = await wrap.getAttribute('aria-pressed')
    await wrap.click()
    t.check((await wrap.getAttribute('aria-pressed')) === (was === 'true' ? 'false' : 'true'), 'Wrap toggles (aria-pressed)')
    await wrap.click()
    await pane(page).getByRole('button', { name: 'Copy', exact: true }).click()
    await pane(page).getByRole('button', { name: 'Copied', exact: true }).waitFor({ timeout: 3000 }).catch(() => t.check(false, 'Copy: no "Copied"'))
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `clipboard not readable: ${e.message}`)
    t.check(clip.split('\n').length === 125 && clip.endsWith(`${tag} 000124 served`), `Copy copies every loaded line (${clip.split('\n').length} lines, ends "${clip.slice(-30)}")`)

    // the daemon line links to the log; the last tab is kept
    await editor(page).getByRole('tab', { name: 'Terminals', exact: true }).click()
    await pane(page).waitFor({ state: 'detached' })
    const link = editor(page).getByRole('button', { name: 'Open daemon log', exact: true }).first()
    if (t.check((await link.count()) > 0, 'the daemon line has "Open daemon log"')) {
      await link.click()
      await pane(page).waitFor()
      t.check((await editor(page).getByRole('tab', { name: 'Daemon log', exact: true }).getAttribute('aria-selected')) === 'true', '"Open daemon log" opens the tab')
    }
    await jump(page, cfg.machineTitle)
    await jump(page, sb.title)
    t.check((await editor(page).getByRole('tab', { name: 'Daemon log', exact: true }).getAttribute('aria-selected')) === 'true', 'the Sandbox page opens on its last tab')

    // the machine page: a Worker log tab only when the machine offers one
    await jump(page, cfg.machineTitle)
    if (has.machineLog) {
      const m = targets.machine, mtag = newTag('s1m')
      await openQuiet(page, m)
      driver.fill('machine', m.name, 60, mtag)
      t.check(same((await tabs(page)).filter((x) => x !== 'Files'), ['Overview', 'Worker log']), `Machine tabs: ${JSON.stringify(await tabs(page))}`)
      await showLog(page, m)
      got = await waitPane(page, (s) => s.state === 'ready' && seqsOf(s.rows, mtag).length === 60)
      t.check(got.ok && same(seqsOf(got.state.rows, mtag), range(0, 59)), `the worker log shows its 60 lines (state ${got.state?.state}, ${got.state?.lines} lines)`)
      await shot(page, 'inspect-logs-s1-worker')
    } else {
      t.check(!(await hasTab(page, 'Worker log')), `machine ${cfg.machine} offers no worker log (supports.log ${has.machine?.supports?.log}): no Worker log tab`)
      t.note(`machine ${cfg.machine}: daemon log only (supports.log ${has.machine?.supports?.log}, CLI call ${has.inspect.machineLog})`)
    }
  })

  await run.row('P1', 'a 5,000-line log loads by cursor; Earlier lines pages back; the page stays responsive', async (t) => {
    const target = await primary(page), tag = newTag('p1')
    await openQuiet(page, target)
    driver.fill(target.kind, target.name, 5000, tag)
    await page.evaluate(() => {
      window.__long = { max: 0, n: 0 }
      try { new PerformanceObserver((list) => { for (const e of list.getEntries()) { window.__long.n++; window.__long.max = Math.max(window.__long.max, e.duration) } }).observe({ entryTypes: ['longtask'] }) } catch { window.__long = null }
    })
    const mark = spawnMark()
    const t0 = Date.now()
    await showLog(page, target)
    let got = await waitPane(page, (s) => s.state === 'ready' && s.lines > 0)
    t.note(`first answer shown ${Date.now() - t0} ms after the tab was clicked`)
    t.check(got.ok && same(seqsOf(got.state.rows, tag), range(4800, 4999)), `the tab opens on the last 200 lines: ${brief(seqsOf(got.state.rows, tag))}`)
    t.check(got.state.earlier && !got.state.start, 'it offers "Earlier lines"')

    // page back to the start; the line the reader was on stays where it was
    const place = () => page.evaluate(() => { const el = [...document.querySelectorAll('[data-log-scroll]')].find((e) => e.offsetParent); const row = el.querySelector('[data-row]'); return { id: row.getAttribute('data-row'), top: row.getBoundingClientRect().top } })
    const topOf = (id) => page.evaluate((id) => [...document.querySelectorAll('[data-log-scroll]')].find((e) => e.offsetParent).querySelector(`[data-row="${id}"]`)?.getBoundingClientRect().top ?? null, id)
    let clicks = 0, slowest = 0, moved = 0
    for (; clicks < 40; clicks++) {
      const now = await paneState(page)
      if (!now.earlier) break
      await pane(page).locator('[data-log-earlier]').scrollIntoViewIfNeeded()
      const before = await place()
      const c0 = Date.now()
      await pane(page).locator('[data-log-earlier]').click()
      const next = await waitPane(page, (s) => s.lines > now.lines || s.stale !== null, { timeout: 10000, every: 50 })
      slowest = Math.max(slowest, Date.now() - c0)
      if (!t.check(next.ok && next.state.stale === null, `Earlier lines #${clicks + 1} brought lines (state ${next.state?.state}, stale ${next.state?.stale})`)) break
      const after = await topOf(before.id)
      moved = Math.max(moved, after === null ? Infinity : Math.abs(after - before.top))
    }
    got = await waitPane(page, (s) => s.start, { timeout: 5000 })
    t.check(got.ok && got.state.lines === 5000, `after ${clicks} "Earlier lines" reads the start of the log is reached with ${got.state?.lines} lines loaded`)
    t.check(same(seqsOf(got.state.rows, tag), range(0, 4999)), `all 5,000 lines, in order, each once: ${brief(seqsOf(got.state.rows, tag))}`)
    t.check(moved <= 2, `the line the reader was on stays in place when earlier lines go in front (moved at most ${moved} px)`)
    t.check(slowest < 3000, `each "Earlier lines" read is shown in under 3 s (slowest ${slowest} ms)`)
    if (spawns()) {
      const made = spawnsSince(mark).inspect.map((s) => s.argv)
      const backs = made.filter((a) => a.includes('--before')), tails = made.filter((a) => !a.includes('--before') && !a.includes('--cursor'))
      t.check(tails.length === 1, `one tail read without a cursor (${tails.length})`)
      t.check(backs.length === clicks && backs.every((a) => a[a.indexOf('--limit') + 1] === '500'), `each "Earlier lines" is one read by --before with --limit 500 (${backs.length} reads for ${clicks} clicks)`)
      t.check(made.every((a) => a.includes('--before') || a.includes('--cursor') || tails.includes(a)), 'every other read is by --cursor')
      t.note(`${made.length} log reads in all: 1 tail, ${backs.length} by --before, ${made.length - 1 - backs.length} by --cursor`)
    } else t.note('no spawn log: the reads\' arguments were not checked')

    // responsive with 5,000 lines loaded
    const find = pane(page).getByRole('textbox', { name: 'Find in loaded lines' })
    const f0 = Date.now()
    await find.fill(`${tag} 002500`)
    await pane(page).getByText('1 of 1', { exact: true }).waitFor({ timeout: 5000 }).catch(() => t.check(false, 'find in 5,000 lines: no "1 of 1"'))
    const findMs = Date.now() - f0
    t.check(findMs < 2000, `find in 5,000 loaded lines answers in under 2 s (${findMs} ms)`)
    await find.press('Escape')
    const frame = await page.evaluate(() => new Promise((r) => { const s = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - s))) }))
    t.check(frame < 500, `two animation frames in under 500 ms with 5,000 lines loaded (${Math.round(frame)} ms)`)
    const long = await page.evaluate(() => window.__long)
    if (long) { t.check(long.max < 1000, `no task blocked the page for 1 s or more (longest ${Math.round(long.max)} ms, ${long.n} over 50 ms)`) } else t.note('longtask timing is not available in this browser')
    t.note(`responsiveness with 5,000 lines: slowest "Earlier lines" read shown in ${slowest} ms (${clicks} reads), find answered in ${findMs} ms, two frames in ${Math.round(frame)} ms, longest task ${long ? `${Math.round(long.max)} ms (${long.n} over 50 ms)` : 'not measured'}; the reader's line moved at most ${moved} px`)

    // new lines still arrive by cursor, and the window stays bounded
    await pane(page).getByRole('button', { name: 'Read again', exact: true }).first().click()
    driver.append(target.kind, target.name, 5000, 50, tag)
    got = await waitPane(page, (s) => seqsOf(s.rows, tag).at(-1) === 5049, { timeout: 15000 })
    const seqs = seqsOf(got.state.rows, tag)
    t.check(got.ok, `50 appended lines arrive (last line ${seqs.at(-1)})`)
    t.check(got.state.lines <= 5000 && same(seqs, range(seqs[0], 5049)), `the window stays bounded and whole: ${got.state.lines} lines, ${brief(seqs)}`)
    t.check(got.state.earlier || got.state.cut, 'the cut top offers "Earlier lines" again, or says earlier lines are gone')
    await shot(page, 'inspect-logs-p1')
  })

  await run.row('P5', 'a rotation while polling: "log replaced" divider, no duplicate lines', async (t) => {
    const target = await primary(page), tag = newTag('p5')
    await openQuiet(page, target)
    driver.fill(target.kind, target.name, 300, tag)
    await showLog(page, target)
    let got = await waitPane(page, (s) => s.state === 'ready' && seqsOf(s.rows, tag).length === 200)
    t.check(got.ok && same(seqsOf(got.state.rows, tag), range(100, 299)), `before the rotation: ${brief(seqsOf(got.state?.rows ?? [], tag))}`)
    driver.rotate(target.kind, target.name)
    driver.append(target.kind, target.name, 300, 20, tag)
    got = await waitPane(page, (s) => s.rows.includes('---') && seqsOf(s.rows, tag).at(-1) === 319, { timeout: 15000 })
    t.check(got.ok, `the pane shows a "log replaced" divider and the new log (state ${got.state?.state}, stale ${got.state?.stale})`)
    const rows = got.state.rows, at = rows.indexOf('---')
    t.check(rows.filter((r) => r === '---').length === 1, 'one divider')
    t.check(same(seqsOf(rows.slice(0, at), tag), range(100, 299)), `above the divider: the lines read before, kept (${brief(seqsOf(rows.slice(0, at), tag))})`)
    t.check(same(seqsOf(rows.slice(at + 1), tag), range(300, 319)), `below it: the new log's lines (${brief(seqsOf(rows.slice(at + 1), tag))})`)
    t.check(new Set(seqsOf(rows, tag)).size === seqsOf(rows, tag).length, 'no line is shown twice')
    t.check((await pane(page).locator('[data-log-replaced]').textContent()) === 'The log was replaced. The new log starts here.', 'the divider says the log was replaced')
    t.check(got.state.stale === null && /^Following/.test(got.state.status), `no refusal is left showing (status "${got.state.status}")`)
    t.check(!got.state.start && !got.state.earlier && got.state.cut, 'the top no longer offers the old log\'s earlier lines, and does not call itself the start')
    driver.append(target.kind, target.name, 320, 5, tag)
    got = await waitPane(page, (s) => seqsOf(s.rows, tag).at(-1) === 324, { timeout: 15000 })
    t.check(got.ok && got.state.rows.filter((r) => r === '---').length === 1 && same(seqsOf(got.state.rows, tag), range(100, 324)), `the new log is followed on: ${brief(seqsOf(got.state.rows, tag))}`)
    if (spawns()) t.note('the stale cursor was answered InvalidInput, then one tail read without a cursor (see F5 for the route\'s answer)')
    await shot(page, 'inspect-logs-p5')
  })

  await run.row('F13', 'an empty log shows its state (log part)', async (t) => {
    const target = await primary(page), tag = newTag('f13')
    await openQuiet(page, target)
    driver.truncate(target.kind, target.name)
    await showLog(page, target)
    let got = await waitPane(page, (s) => s.state === 'ready')
    t.check(got.ok && got.state.lines === 0 && got.state.rows.length === 0, `an empty log: state ${got.state?.state}, ${got.state?.lines} lines`)
    t.check((await pane(page).getByText('The log is empty', { exact: true }).count()) === 1, 'it says "The log is empty"')
    t.check(got.state.stale === null, 'an empty log is not a refusal')
    t.check(await pane(page).getByRole('button', { name: 'Copy', exact: true }).isDisabled(), 'Copy is disabled with nothing loaded')
    await shot(page, 'inspect-logs-f13')
    driver.append(target.kind, target.name, 0, 2, tag)
    got = await waitPane(page, (s) => seqsOf(s.rows, tag).length === 2, { timeout: 15000 })
    t.check(got.ok && got.state.start, `the first lines written appear (${brief(seqsOf(got.state.rows, tag))})`)
  })
})
