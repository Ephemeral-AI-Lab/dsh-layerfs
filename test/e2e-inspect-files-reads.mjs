#!/usr/bin/env node
// Files reads that are refused, wait, or are no longer wanted
// (layerfs-project#178 matrix):
//   F5  refusal codes shown: a stale cursor, an escaping path, a FIFO, and the inspect lane's `Busy` with "Read again"
//   F8  a refusal in the Whole filesystem view (`Busy`, the time limit) stays in that view; the other view keeps working
//   P7  a queued folder read is dropped when its folder collapses (no spawn); a read that waits shows its time with Cancel
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… INSPECT_SANDBOX=… [INSPECT_WHOLE_MACHINE=…] \
//     [INSPECT_STANDIN_DIR=… | INSPECT_HOOK=… INSPECT_FILES_BASE_<TARGET>=…] node test/e2e-inspect-files-reads.mjs [--rows F5,F8,P7]
// Environment, material and what every row also checks: test/e2e-inspect-files-lib.mjs.
import {
  NotRun, T, baseOf, files, filesDriver, filesSpawns, filesState, forgetPlace, goPath, main, moreButton, moreOf, need, openFiles, outside, requestsTo, row, rowOf, setup, shot, sleep, spawnMark, spawns, spawnsSince,
  switchView, toggle, under, waitFiles,
} from './e2e-inspect-files-lib.mjs'

const enc = encodeURIComponent
const routeOf = (target) => `/api/${target.kind === 'machine' ? 'machines' : 'sandboxes'}/${enc(target.name)}/files`
/** What the tab says about a refusal with `code`: under a folder that has nothing to show, or as the mark on a listing kept from before. */
const said = (state, code) => [...(state?.refusals ?? []), ...(state?.stale ?? [])].find((x) => x.code === code)
const readAgain = (page) => files(page).getByRole('button', { name: 'Read again', exact: true })

setup()
await main('e2e-inspect-files-reads', async ({ run, page, browser }) => {
  await forgetPlace(page)

  await run.row('F5', 'refusal codes shown: stale cursor, escaping path, FIFO, inspect lane Busy with Read again', async (t) => {
    const target = need(T.sandbox)
    const base = baseOf(target)
    await openFiles(page, target)
    await goPath(page, base)
    // a cursor LayerFS no longer takes: the More row says so and reads again
    const many = `${base}/many`
    let got = await toggle(page, many)
    const first = under(got.state, many).length
    t.check(got.ok && !!moreOf(got.state, many), `a first page of ${first} with More entries`)
    filesDriver.refuse(target, 'InvalidInput', 'the cursor names no entry of this folder', many)
    await moreButton(page, many).click()
    got = await waitFiles(page, (s) => s.refusals.some((r) => r.code === 'InvalidInput'))
    t.check(got.ok && /the cursor names no entry of this folder/.test(got.state.refusals[0].text), `a refused cursor shows its code and words (${JSON.stringify(got.state.refusals)})`)
    t.check(under(got.state, many).length === first && moreOf(got.state, many)?.text === 'Read again', `the entries read stay, and the row reads "Read again" (${moreOf(got.state, many)?.text})`)
    await shot(page, 'inspect-files-f5-cursor')
    filesDriver.unrefuse(target, many)
    await moreButton(page, many).click()
    got = await waitFiles(page, (s) => under(s, many).length > first && s.refusals.length === 0)
    t.check(got.ok, `Read again reads the next page (${under(got.state, many).length})`)
    await toggle(page, many)
    // an escaping path
    await goPath(page, `${base}/../../../../etc/passwd`)
    got = await waitFiles(page, (s) => s.notice !== null)
    t.check(got.ok && /InvalidInput/.test(got.state.notice) && got.state.file === '', `a path with .. is refused with its code, and nothing opens ("${(got.state.notice ?? '').slice(0, 160)}")`)
    // a FIFO
    await goPath(page, base)
    const fifo = rowOf(await filesState(page), `${base}/pipe`)
    t.check(fifo && fifo.kind === 'other' && fifo.disabled && /Not a regular file or folder, not read/.test(fifo.title ?? ''), `a FIFO is listed and cannot be opened (${fifo?.kind}, "${fifo?.title}")`)
    await goPath(page, `${base}/pipe`)
    got = await waitFiles(page, (s) => s.notice !== null)
    t.check(got.ok && /pipe could not be opened \(InvalidInput/.test(got.state.notice), `Go to it: refused with its code, without a wait ("${(got.state.notice ?? '').slice(0, 200)}")`)
    await shot(page, 'inspect-files-f5-fifo')

    // the inspect lane is full: Busy at once, with Read again
    await goPath(page, base)
    filesDriver.hang(target, 9000)
    const h0 = Date.now()
    const others = [await outside(browser), await outside(browser)]
    try {
      const paths = ['data.bin', 'sub/deep', 'emptydir', 'slow', 'many', 'notes.txt'].map((p) => `${base}/${p}`)
      // two run, four wait: the lane and its queue are full
      const flights = paths.map((p, i) => others[i % 2].evaluate(({ url }) => window.__dshLayerfs.call('GET', url).then((v) => v.kind, (e) => `error ${e.code}`), { url: `${routeOf(target)}?path=${enc(p)}&rid=f5-${i}` }))
      await sleep(1500)
      const b0 = Date.now()
      await row(page, `${base}/sub`).click()
      got = await waitFiles(page, (s) => !!said(s, 'Busy'), { timeout: 6000 })
      t.check(got.ok, `a read past the lane and its queue is refused \`Busy\` at once (${Date.now() - b0} ms; ${JSON.stringify(said(got.state, 'Busy'))})`)
      t.check((await readAgain(page).count()) >= 1, 'with "Read again"')
      await shot(page, 'inspect-files-f5-busy')
      filesDriver.unhang(target)
      const kinds = await Promise.all(flights)
      t.note(`the six reads that filled the lane answered ${kinds.join(', ')} ${Date.now() - h0} ms after the hang began`)
      await readAgain(page).first().click()
      got = await waitFiles(page, (s) => !said(s, 'Busy') && under(s, `${base}/sub`).length > 0, { timeout: 15000 })
      t.check(got.ok, 'when the lane is free, Read again lists the folder')
    } finally { filesDriver.unhang(target); for (const p of others) await p.context().close().catch(() => {}) }
  })

  await run.row('F8', 'a refusal in the Whole filesystem view stays in that view; the other view keeps working', async (t) => {
    const w = need(T.wholeMachine)
    await openFiles(page, w)
    const layer = await filesState(page)
    if (layer.views.length !== 2) throw new NotRun(`machine ${w.name} offers no Whole filesystem view`)
    const logs = layer.rows.find((r) => /^Logs/.test(r.text)) ?? layer.rows[0]
    await switchView(page, 'Whole filesystem (/)')
    // Busy on a folder not read yet
    filesDriver.refuse(w, 'Busy', 'two inspect reads are running on this machine', '/etc')
    await row(page, '/etc').click()
    let got = await waitFiles(page, (s) => !!said(s, 'Busy'))
    t.check(got.ok && got.state.view === 'whole' && /two inspect reads are running/.test(said(got.state, 'Busy').text), `Whole filesystem: /etc shows \`Busy\` and its words (${JSON.stringify(said(got.state, 'Busy'))})`)
    // the time limit on a folder already read: its listing stays, marked
    filesDriver.refuse(w, 'Unavailable', 'the read passed its time limit', '/')
    await files(page).getByRole('button', { name: 'Refresh', exact: true }).click()
    got = await waitFiles(page, (s) => s.stale.some((x) => x.code === 'Unavailable'))
    const limit = said(got.state, 'Unavailable')
    t.check(got.ok && /the read passed its time limit/.test(limit.text) && /Showing the answer from/.test(limit.text) && got.state.rows.some((r) => r.key === '/etc'), `Refresh refused at the time limit: / keeps its listing, marked with its time ("${limit?.text.slice(0, 120)}")`)
    await shot(page, 'inspect-files-f8-whole')
    // the other view
    await switchView(page, 'LayerFS folders')
    got = await waitFiles(page, (s) => s.view === 'layerfs' && s.state === 'ready')
    t.check(got.ok && got.state.refusals.length === 0 && got.state.stale.length === 0 && got.state.notice === null, 'LayerFS folders shows none of it')
    if (rowOf(got.state, logs.key)?.expanded !== 'true') await toggle(page, logs.key)
    got = await waitFiles(page, (s) => under(s, logs.key).length > 0)
    t.check(got.ok, `and still reads: ${logs.key} lists ${under(got.state, logs.key).length} entries`)
    await files(page).getByRole('button', { name: 'Refresh', exact: true }).click()
    await sleep(800)
    got = await waitFiles(page, (s) => s.state === 'ready' && under(s, logs.key).length > 0)
    t.check(got.ok && got.state.refusals.length === 0 && got.state.stale.length === 0, 'its own Refresh is not refused')
    await shot(page, 'inspect-files-f8-layerfs')
    // back: the refusals are where they were, and end when the reads answer again
    await switchView(page, 'Whole filesystem (/)')
    got = await waitFiles(page, (s) => s.view === 'whole' && !!said(s, 'Unavailable') && !!said(s, 'Busy'))
    t.check(got.ok, `back in Whole filesystem: both refusals still shown (${JSON.stringify({ stale: got.state?.stale.map((x) => x.code), refused: got.state?.refusals.map((x) => x.code) })})`)
    filesDriver.unrefuse(w, '/etc'); filesDriver.unrefuse(w, '/')
    await files(page).getByRole('button', { name: 'Refresh', exact: true }).click()
    got = await waitFiles(page, (s) => s.stale.length === 0 && s.refusals.length === 0 && under(s, '/etc').length > 0, { timeout: 15000 })
    t.check(got.ok, `Refresh when the reads answer again: no mark, /etc listed (${JSON.stringify({ stale: got.state?.stale.length, refused: got.state?.refusals.length, etc: under(got.state, '/etc').length })})`)
    await toggle(page, '/etc')
    await switchView(page, 'LayerFS folders')
  })

  await run.row('P7', 'a queued folder read is dropped when its folder collapses (no spawn); a waiting read shows its time with Cancel', async (t) => {
    const target = need(T.sandbox)
    const base = baseOf(target)
    await openFiles(page, target)
    await goPath(page, base)
    const [a, b, c] = ['sub', 'emptydir', 'slow'].map((p) => `${base}/${p}`)
    const mark = spawnMark()
    const asked0 = (await requestsTo(page, /\/files\?/)).length
    filesDriver.hang(target, 7000)
    try {
      // two reads run (the page lets two at a time through); the third waits in the page
      await row(page, a).click()
      await row(page, b).click()
      await row(page, c).click()
      await sleep(600)
      let s = await filesState(page)
      t.check([a, b, c].every((p) => rowOf(s, p).busy && rowOf(s, p).expanded === 'true') && s.busy, 'three folders opened: each is aria-busy, and so is the tab')
      let asked = (await requestsTo(page, /\/files\?/)).slice(asked0)
      t.check(asked.length === 2 && asked.every((r) => !r.what.includes(enc(c))), `the page sent two reads and holds the third (${asked.length} sent)`)
      // collapse the third: it is never sent
      await row(page, c).click()
      await sleep(900)
      s = await filesState(page)
      t.check(rowOf(s, c).expanded === 'false' && !rowOf(s, c).busy, 'the third folder collapsed')
      // a read that waits says for how long, with Cancel
      const wait = s.reading.find((x) => x.path === a)
      t.check(wait && /Reading… \d+ s/.test(wait.text) && /Cancel/.test(wait.text), `after 1 s a waiting read shows its time and Cancel ("${wait?.text}")`)
      await shot(page, 'inspect-files-p7-waiting')
      // Cancel the first: the page tells the host, which ends the read
      await files(page).locator(`[data-tree-reading=${JSON.stringify(a)}]`).getByRole('button', { name: 'Cancel', exact: true }).click()
      await sleep(600)
      s = await filesState(page)
      t.check(!s.reading.some((x) => x.path === a), `Cancel drops the read of ${a.split('/').pop()} (${JSON.stringify(s.reading.map((x) => x.path.split('/').pop()))})`)
      const cancels = await requestsTo(page, /^inspect\.cancel$/)
      t.check(cancels.length >= 1, `the page told the host to drop it (inspect.cancel × ${cancels.length})`)
      filesDriver.unhang(target)
      const got = await waitFiles(page, (x) => x.reading.length === 0 && !x.busy, { timeout: 15000 })
      t.check(got.ok && got.state.empty.includes(b), 'the read still wanted answers when the hang ends')
      asked = (await requestsTo(page, /\/files\?/)).slice(asked0)
      t.check(!asked.some((r) => r.what.includes(enc(c))), `the collapsed folder's read never left the page (${asked.length} files requests in all)`)
      if (spawns()) {
        const made = filesSpawns(spawnsSince(mark))
        t.check(made.length === 2 && !made.some((x) => x.argv.includes(c)), `and never became a CLI process: ${made.length} files processes, none for ${c.split('/').pop()}`)
      } else t.note('no spawn log: CLI processes were not counted')
    } finally { filesDriver.unhang(target) }
    for (const p of [a, b]) if (rowOf(await filesState(page), p)?.expanded === 'true') await row(page, p).click()
  })
})
