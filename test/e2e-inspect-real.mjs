#!/usr/bin/env node
// Rows of the layerfs-project#178 matrix that only a REAL build shows, by real means (no fault is injected;
// with the stand-in every row is NOT_RUN):
//   F1    a stopped machine: its Files and Worker log tabs show `Unavailable` with Start
//   F2    the worker stops answering while the tabs are open (its process is paused): the log tab keeps its lines
//         and says so, Files shows `Unavailable` with Read again; when it answers again both recover
//   F14   a machine is stopped while its Files tab reads: the reads end as `Unavailable`, the page stays up
//   F11r  a Sandbox whose daemon was killed: Home still browsable, Whole filesystem `Unavailable` in LayerFS's words
//   F5r   the machine's two inspect slots are taken by another client's reads: a read of the page is refused `Busy`
//         by LayerFS itself, with Read again
//
//   INSPECT_STOPPED_MACHINE   a stopped machine (F1)
//   INSPECT_MACHINE(+_TITLE)  a running machine with a worker (F2); INSPECT_HOOK does `worker-pause` / `worker-resume`
//   INSPECT_STOP_MACHINE      a machine this script may start and stop by force (F14: `machine-start` / `machine-stop`);
//                             it is left stopped
//   INSPECT_DEAD_SANDBOX      a Sandbox recorded running whose daemon process was killed (F11r)
//   INSPECT_HUGE_FOLDER       on INSPECT_MACHINE, a folder with some 400,000 entries (a page of it takes LayerFS about
//                             0.1 s): F5r reads it from six loops of the real CLI ($LFS_REAL_CLI, else the pinned CLI)
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs.
import { execFile, spawn, spawnSync } from 'node:child_process'
import {
  NotRun, cfg, driver, editor, files, filesSpawns, filesState, forgetPlace, goPath, jump, lfs, main, newTag, offered, openLog, pane, rowOf, seqsOf, shot, showFiles,
  sleep, spawnMark, spawns, spawnsSince, switchView, tabs, targets, toggle, under, waitFiles, waitPane,
} from './e2e-inspect-files-lib.mjs'

const said = (state, code) => [...(state?.refusals ?? []), ...(state?.stale ?? [])].find((x) => x.code === code)
const readAgain = (page) => files(page).getByRole('button', { name: 'Read again', exact: true })
function act(action, name) {
  if (cfg.standin) throw new NotRun('a real build only: the stand-in has no machine to stop or pause')
  if (!cfg.hook) throw new NotRun(`no INSPECT_HOOK: nothing here can \`${action}\` machine ${name}`)
  const r = spawnSync(cfg.hook, [action, 'machine', name], { encoding: 'utf8', timeout: 100000 })
  if (r.status === 3) throw new NotRun(`INSPECT_HOOK cannot \`${action}\` here: ${(r.stdout || r.stderr || '').trim() || 'no reason given'}`)
  if (r.status !== 0) throw new Error(`INSPECT_HOOK ${action} machine ${name} failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`)
}
const refusalOf = (...args) => { try { lfs(...args); return null } catch (error) { try { return JSON.parse(String(error.stderr ?? '').trim().split('\n').pop()) } catch { return { code: '?', message: String(error.stderr ?? error.message).slice(0, 200) } } } }
// a machine's power button: "Start", on the built-in docker machine "Start worker" ("Restart worker" while its worker does not answer)
const start = (page, within) => within(page).getByRole('button', { name: /^(Start|Start worker|Restart worker)$/ })
const logUnavailable = (page) => pane(page).locator('[data-log-unavailable]')

await main('e2e-inspect-real', async ({ run, page }) => {
  await forgetPlace(page)

  await run.row('F1', 'a stopped machine: its Files and Worker log tabs show `Unavailable` with Start', async (t) => {
    if (cfg.standin) throw new NotRun('a real build only')
    const name = process.env.INSPECT_STOPPED_MACHINE
    if (!name) throw new NotRun('INSPECT_STOPPED_MACHINE is not set')
    const answer = refusalOf('machine', 'files', name)
    t.check(answer?.code === 'Unavailable', `LayerFS refuses \`machine files ${name}\` with Unavailable (${JSON.stringify(answer)})`)
    const mark = spawns() ? spawnMark() : null
    await jump(page, process.env.INSPECT_STOPPED_MACHINE_TITLE || name)
    const names = await tabs(page)
    t.note(`the stopped machine's tabs: ${JSON.stringify(names)}`)
    if (names.includes('Files')) {
      await editor(page).getByRole('tab', { name: 'Files', exact: true }).click()
      await files(page).waitFor()
      const got = await waitFiles(page, (s) => !!said(s, 'Unavailable'), { timeout: 20000 })
      const x = said(got.state, 'Unavailable')
      t.check(got.ok, `Files: the refusal \`Unavailable\` is shown (${JSON.stringify(x ?? got.state?.refusals)})`)
      t.check((x?.text ?? '').includes(answer?.message ?? '\u0000'), 'in LayerFS\'s own words')
      t.check((await start(page, files).count()) >= 1, 'with Start beside it')
      t.check(got.state.rows.length === 0 || got.state.stale.length > 0, `no listing is shown as current (${got.state.rows.length} rows, ${got.state.stale.length} stale marks)`)
      await shot(page, 'inspect-real-f1-files')
    } else t.check(false, 'the stopped machine has no Files tab')
    if (names.includes('Worker log')) {
      await editor(page).getByRole('tab', { name: 'Worker log', exact: true }).click()
      await pane(page).waitFor()
      const seen = await logUnavailable(page).waitFor({ timeout: 15000 }).then(() => true, () => false)
      const text = seen ? await logUnavailable(page).textContent() : ''
      t.check(seen && /Unavailable/.test(text), `Worker log: \`Unavailable\` is shown ("${(text ?? '').slice(0, 160)}")`)
      t.check((await start(page, pane).count()) === 1, 'with Start beside it')
      await sleep(6000)
      await shot(page, 'inspect-real-f1-log')
    } else t.note('the stopped machine has no Worker log tab')
    if (mark !== null) {
      const made = spawnsSince(mark).inspect.filter((s) => s.argv.includes(name))
      t.note(`CLI reads of the stopped machine while its tabs were open (about 10 s): ${made.length} (${made.map((s) => s.argv.slice(0, 2).join(' ')).join(', ') || 'none'})`)
      t.check(made.filter((s) => s.argv[1] === 'stats').length === 0, 'a stopped machine is never asked for its stats')
      t.check(made.length <= 4, `the tabs do not poll a stopped machine (${made.length} reads)`)
    }
  })

  await run.row('F2', 'the worker stops answering while the tabs are open: lines kept and marked, Files `Unavailable` with Read again; both recover', async (t) => {
    const target = targets.machine
    const has = await offered(page)
    if (!has.machineLog) throw new NotRun(`machine ${cfg.machine} offers no worker log (its calls run in this process): there is no worker to pause`)
    const tag = newTag('f2')
    driver.fill('machine', target.name, 20, tag)
    await openLog(page, target)
    let got = await waitPane(page, (s) => s.state === 'ready' && seqsOf(s.rows, tag).length === 20)
    t.check(got.ok, 'the worker log is shown and followed')
    act('worker-pause', target.name)
    const paused = Date.now()
    try {
      const answer = refusalOf('machine', 'files', target.name)
      t.check(answer?.code === 'Unavailable', `LayerFS answers a paused worker with Unavailable (${JSON.stringify(answer).slice(0, 220)})`)
      got = await waitPane(page, (s) => s.stale === 'Unavailable', { timeout: 30000, every: 250 })
      const banner = (await logUnavailable(page).count()) > 0
      t.check(got.ok || banner, `the log tab says \`Unavailable\` ${Date.now() - paused} ms after the pause (${banner ? 'the stopped-machine notice' : `stale mark: "${(got.state?.staleText ?? '').slice(0, 140)}"`})`)
      t.note(`paused worker: the log tab said \`Unavailable\` ${Date.now() - paused} ms after the pause (${banner ? 'the stopped-machine notice with Start: `machine status` reads a machine whose worker does not answer as stopped' : 'a stale mark over the lines'}); LayerFS: "${String(answer?.message ?? '').slice(0, 150)}"`)
      t.check(seqsOf((await waitPane(page, () => true)).state.rows, tag).length === 20, 'the lines read before stay')
      await shot(page, 'inspect-real-f2-log')
      await showFiles(page, { timeout: 25000 }).catch(() => {})
      let f = await waitFiles(page, (s) => !!said(s, 'Unavailable'), { timeout: 25000 })
      t.check(f.ok, `Files shows \`Unavailable\` (${JSON.stringify(said(f.state, 'Unavailable') ?? f.state?.refusals).slice(0, 240)})`)
      t.check((await readAgain(page).count()) + (await start(page, files).count()) >= 1, 'with Read again, or Start once the machine reads as stopped')
      await shot(page, 'inspect-real-f2-files')
      act('worker-resume', target.name)
      const resumed = Date.now()
      driver.append('machine', target.name, 20, 5, tag)
      // Files: nothing polls, so the viewer reads again
      const again = readAgain(page)
      f = await waitFiles(page, () => true)
      for (const until = Date.now() + 30000; Date.now() < until;) {
        if (await again.count()) await again.first().click().catch(() => {})
        f = await waitFiles(page, (s) => s.state === 'ready' && s.rows.length > 0 && !said(s, 'Unavailable'), { timeout: 4000 })
        if (f.ok) break
      }
      t.check(f.ok, `Files lists again ${Date.now() - resumed} ms after the worker answers (${f.state?.rows.length} rows)`)
      t.note(`resumed worker: Files listed again ${Date.now() - resumed} ms after (Read again)`)
      await editor(page).getByRole('tab', { name: target.tab, exact: true }).click()
      await pane(page).waitFor()
      got = await waitPane(page, (s) => seqsOf(s.rows, tag).at(-1) === 24 && s.stale === null, { timeout: 45000, every: 300 })
      t.check(got.ok, `the log tab recovers without a click and shows the lines written meanwhile (${Date.now() - resumed} ms after the worker answers; last ${seqsOf(got.state?.rows ?? [], tag).at(-1)}, stale ${got.state?.stale})`)
      t.note(`resumed worker: the log tab showed the new lines ${Date.now() - resumed} ms after, without a click`)
    } finally { try { act('worker-resume', target.name) } catch { /* reported above */ } }
  })

  await run.row('F14', 'a machine is stopped while its Files tab reads: the reads end as `Unavailable`, the page stays up', async (t) => {
    if (cfg.standin) throw new NotRun('a real build only')
    const name = process.env.INSPECT_STOP_MACHINE
    if (!name) throw new NotRun('INSPECT_STOP_MACHINE is not set (a machine this row may start, and stop by force)')
    if (lfs('machine', 'status', name).state !== 'running') { const s0 = Date.now(); act('machine-start', name); t.note(`machine ${name} started for this row in ${Date.now() - s0} ms`) }
    const roots = lfs('machine', 'files', name).entries
    const whole = roots.some((e) => e.role === 'machine')
    await jump(page, process.env.INSPECT_STOP_MACHINE_TITLE || name)
    await editor(page).getByRole('tab', { name: 'Files', exact: true }).waitFor({ timeout: 20000 })
    await showFiles(page, { timeout: 25000 })
    if (whole && (await filesState(page)).view !== 'whole') await switchView(page, 'Whole filesystem (/)')
    const top = whole ? '/usr' : roots[0].path
    await goPath(page, top)
    let got = await waitFiles(page, (s) => s.base === top && s.rows.length > 0, { timeout: 20000 })
    if (!t.check(got.ok, `${top} is listed while the machine runs (${got.state?.rows.length} rows)`)) return
    const folders = got.state.rows.filter((r) => r.kind === 'folder' && !r.disabled).slice(0, 4)
    const mark = spawns() ? spawnMark() : null
    // the stop, and reads started while it runs
    const stop = spawn(cfg.hook, ['machine-stop', 'machine', name], { stdio: 'ignore' })
    const stopped = new Promise((resolve) => stop.on('exit', resolve))
    const t0 = Date.now()
    for (const r of folders) { await files(page).locator(`[data-files-tree] [data-tree-key=${JSON.stringify(r.key)}]`).click({ timeout: 3000 }).catch(() => {}); await sleep(120) }
    const code = await stopped
    t.check(code === 0, `\`machine stop ${name} --force\` ended in ${Date.now() - t0} ms (exit ${code})`)
    // a read after the stop
    await files(page).getByRole('button', { name: 'Refresh', exact: true }).click().catch(() => {})
    got = await waitFiles(page, (s) => !!said(s, 'Unavailable'), { timeout: 25000 })
    const x = said(got.state, 'Unavailable')
    t.check(got.ok, `the Files tab shows \`Unavailable\` (${JSON.stringify(x).slice(0, 260)})`)
    t.check(((await editor(page).getByRole('heading', { level: 1 }).first().textContent()) ?? '').length > 0 && (await files(page).count()) === 1, 'the page and its Files tab are still up')
    const offer = await start(page, files).first().waitFor({ timeout: 30000 }).then(() => true, () => false)
    t.check(offer, 'once the machine reads as stopped, Start stands beside the refusal')
    const s = await filesState(page)
    t.note(`after the stop: ${s.rows.length} rows kept from before, ${s.stale.length} stale mark(s), ${s.refusals.length} refusal(s), ${s.reading.length} still reading`)
    t.check(s.reading.length === 0, 'no read is left waiting')
    if (mark !== null) t.note(`files reads that became CLI processes around the stop: ${filesSpawns(spawnsSince(mark)).length}`)
    await shot(page, 'inspect-real-f14')
    t.note(`machine ${name} is left stopped`)
  })

  await run.row('F5r', 'another client holds the machine\'s two inspect slots: the page\'s read is refused `Busy` by LayerFS, with Read again', async (t) => {
    if (cfg.standin) throw new NotRun('a real build only')
    const huge = process.env.INSPECT_HUGE_FOLDER
    if (!huge) throw new NotRun('INSPECT_HUGE_FOLDER is not set')
    const m = targets.machine
    const real = process.env.LFS_REAL_CLI || cfg.cli
    const env = { ...process.env, LAYERFS_HOME: process.env.DSH_LAYERFS_HOME || process.env.LAYERFS_HOME }
    const tally = { ok: 0, Busy: 0, other: 0 }
    let words = null
    const one = () => new Promise((resolve) => execFile(real, ['machine', 'files', m.name, huge, '--limit', '1000'], { env, maxBuffer: 1 << 26, timeout: 20000 }, (error, _out, err) => {
      if (!error) tally.ok++
      else { let code = null; try { const j = JSON.parse(String(err).trim().split('\n').pop()); code = j.code; if (code === 'Busy') words = j.message } catch { /* not a refusal */ } if (code === 'Busy') tally.Busy++; else tally.other++ }
      resolve()
    }))
    await jump(page, m.title)
    await showFiles(page, { timeout: 25000 })
    const s0 = await filesState(page)
    if (!t.check(s0.state === 'ready' && s0.rows.length > 0, `the Files tab lists before the other client starts (${s0.rows.length} rows)`)) return
    let holding = true
    const loops = Array.from({ length: 6 }, async () => { while (holding) await one() })
    try {
      await sleep(400)
      let got = null, tries = 0
      const t0 = Date.now()
      for (; tries < 40 && Date.now() - t0 < 30000;) {
        tries++
        await files(page).getByRole('button', { name: 'Refresh', exact: true }).click().catch(() => {})
        got = await waitFiles(page, (s) => !!said(s, 'Busy'), { timeout: 700, every: 60 })
        if (got.ok) break
      }
      const x = said(got?.state, 'Busy')
      t.check(!!x, `a read of the page was refused \`Busy\` while the other client's reads held the slots (after ${tries} reads in ${Date.now() - t0} ms: ${JSON.stringify(x).slice(0, 240)})`)
      t.check(/inspect requests are running on this machine/.test(x?.text ?? ''), 'in LayerFS\'s own words')
      t.check((await readAgain(page).count()) >= 1, 'with "Read again"')
      await shot(page, 'inspect-real-f5r')
      holding = false
      await Promise.all(loops)
      t.note(`the other client (six loops of the real CLI reading ${huge}, 1,000 entries a page): ${tally.ok} reads answered, ${tally.Busy} refused Busy ("${words ?? ''}"), ${tally.other} other`)
      t.check(tally.Busy > 0 && tally.other === 0, 'that client was refused Busy by LayerFS too, and met nothing else')
      await readAgain(page).first().click().catch(() => {})
      got = await waitFiles(page, (s) => s.state === 'ready' && !said(s, 'Busy') && s.rows.length > 0, { timeout: 15000 })
      t.check(got.ok, 'with the slots free, Read again lists')
    } finally { holding = false; await Promise.all(loops) }
  })

  await run.row('F11r', 'a Sandbox whose daemon was killed: Home still browsable, Whole filesystem `Unavailable` in LayerFS\'s words', async (t) => {
    if (cfg.standin) throw new NotRun('a real build only')
    const name = process.env.INSPECT_DEAD_SANDBOX
    if (!name) throw new NotRun('INSPECT_DEAD_SANDBOX is not set')
    const rec = lfs('sandbox', 'get', name)
    t.note(`sandbox get ${name}: state ${rec.state}, daemon ${JSON.stringify(rec.daemon)}, usage_reason ${rec.usage_reason}`)
    const roots = lfs('sandbox', 'files', name).entries
    const home = roots.find((e) => e.role === 'home')
    const answer = roots.some((e) => e.role === 'root') ? refusalOf('sandbox', 'files', name, '/') : null
    await jump(page, name)
    await showFiles(page, { timeout: 25000 })
    let s = await filesState(page)
    t.check(s.state === 'ready' && !!rowOf(s, home.path), `the Sandbox view lists its roots (${s.rows.length} rows)`)
    let got = await toggle(page, home.path)
    t.check(got.ok && got.state.refusals.length === 0, `Home opens (${under(got.state, home.path).length} entries)`)
    if (!answer) { t.note(`${name}'s roots offer no /: no Whole filesystem view to refuse`); return }
    t.check(answer.code === 'Unavailable', `LayerFS refuses its root with Unavailable (${JSON.stringify(answer).slice(0, 260)})`)
    await switchView(page, 'Whole filesystem (/)')
    got = await waitFiles(page, (x) => !!said(x, 'Unavailable'), { timeout: 15000 })
    const x = said(got.state, 'Unavailable')
    t.check(got.ok && got.state.view === 'whole', `Whole filesystem shows the refusal \`Unavailable\` (${JSON.stringify(x).slice(0, 300)})`)
    t.check((x?.text ?? '').includes('its daemon is not running'), 'in LayerFS\'s words: its daemon is not running, its home is still read')
    t.check((await readAgain(page).count()) >= 1, 'with "Read again"')
    await shot(page, 'inspect-real-f11r')
    await switchView(page, 'Sandbox')
    got = await waitFiles(page, (y) => y.view === 'layerfs' && y.refusals.length === 0 && !!rowOf(y, home.path))
    t.check(got.ok, 'back in the Sandbox view: Home as it was, no refusal')
  })
})
