#!/usr/bin/env node
// The Files tabs of the machine and Sandbox pages in a browser
// (layerfs-project#178 matrix):
//   S2  machine Files: LayerFS folders ranked by role; Whole filesystem from `/`; switching keeps each view's path and open folders
//   S3  Sandbox Files: roots by role (Workspaces with chip, Home, log); Whole filesystem lists `/`; Browse base opens the saved files
//   S4  Go to a pasted path opens it (the Doctor link is #180's: only its receiving side is checked here)
//   P4  a 3,000-entry folder pages with More entries; a 50 MB file pages by window; a deadline page reads "Stopped at the time limit"
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… INSPECT_SANDBOX=… [INSPECT_WHOLE_MACHINE=… INSPECT_WHOLE_SANDBOX=…] \
//     [INSPECT_STANDIN_DIR=… | INSPECT_HOOK=… INSPECT_FILES_BASE_<TARGET>=…] node test/e2e-inspect-files.mjs [--rows S2,S3,S4,P4]
// Environment, material and what every row also checks: test/e2e-inspect-files-lib.mjs.
import {
  BIG_BYTES, MANY, NOTES, NotRun, SLOW, T, baseOf, cfg, editor, files, filesDriver, filesSpawns, filesState, forgetPlace, goPath, itemOf, jump, main, moreButton, moreOf, need, openFiles, openPage, probe, row, rowOf, setup, shot,
  showFiles, sleep, spawnMark, spawns, spawnsSince, switchView, tabs, toggle, under, waitFiles,
} from './e2e-inspect-files-lib.mjs'

const enc = encodeURIComponent
const KNOWN = { data: 'Data disk', stores: 'Stores', sandbox_records: 'Sandbox records', run_folders: 'Sandbox run folders', images: 'Sandbox images', staging: 'Incoming files', logs: 'Logs', state: 'Worker state', bundle: 'LayerFS bundle', image: 'Machine image', home: 'Home' }
const rootsOf = async (page, target) => {
  const r = await probe(page, 'GET', `/api/${target.kind === 'machine' ? 'machines' : 'sandboxes'}/${enc(target.name)}/files`)
  if (!r.ok || r.body.kind !== 'folder') throw new Error(`the roots of ${target.kind} ${target.name}: ${JSON.stringify(r).slice(0, 300)}`)
  return r.body.entries
}

setup()
await main('e2e-inspect-files', async ({ run, page }) => {
  await forgetPlace(page)

  await run.row('S2', 'machine Files: LayerFS folders by role; Whole filesystem from /; switching keeps each view', async (t) => {
    // a machine without `/`: roots by role, no switch
    const m = need(T.machine)
    await openFiles(page, m)
    let s = await filesState(page)
    const roots = await rootsOf(page, m)
    t.check((await tabs(page)).join('|').startsWith('Overview|Files'), `machine tabs: ${JSON.stringify(await tabs(page))}`)
    const offersWhole = roots.some((e) => e.path === '/')
    t.check(s.state === 'ready' && s.rows.length === roots.filter((e) => e.path !== '/').length, `${m.name}: one row per LayerFS root (${s.rows.length} of ${roots.length})`)
    t.check(s.rows.every((r, i) => r.key === roots[i].path), `${m.name}: roots keep the server's order`)
    for (const [i, e] of roots.entries()) {
      if (e.path === '/') continue
      const want = KNOWN[e.role] ?? e.role
      t.check(s.rows[i].text.startsWith(want) && s.rows[i].text.includes(e.path), `${m.name}: root ${e.role} reads "${want}" with its path (${s.rows[i].text})`)
    }
    t.check(offersWhole ? s.views.length === 2 : s.views.length === 0, `${m.name}: ${offersWhole ? 'the roots offer / and the switch shows' : 'the roots offer no / and there is no view switch'} (${JSON.stringify(s.views)})`)
    await shot(page, 'inspect-files-s2-layerfs-only')

    // a machine with `/`
    if (!T.wholeMachine.name) { t.note('INSPECT_WHOLE_MACHINE is not set: the Whole filesystem part was NOT_RUN'); return }
    const w = T.wholeMachine
    await openFiles(page, w)
    s = await filesState(page)
    const wroots = await rootsOf(page, w)
    const layer = wroots.filter((e) => e.path !== '/')
    t.check(wroots.at(-1).path === '/' && wroots.at(-1).role === 'machine', 'the roots answer offers / (role machine) last')
    t.check(s.views.join('|') === 'LayerFS folders|Whole filesystem (/)', `the switch reads LayerFS folders | Whole filesystem (/) (${JSON.stringify(s.views)})`)
    t.check(s.view === 'layerfs' && s.rows.length === layer.length && s.rows.every((r, i) => r.key === layer[i].path), 'LayerFS folders: one row per root, in the server\'s order, without /')
    for (const [i, e] of layer.entries()) t.check(s.rows[i].text.startsWith(KNOWN[e.role] ?? e.role) && s.rows[i].text.includes(e.path), `root ${e.role} reads "${KNOWN[e.role] ?? e.role}" with ${e.path}`)
    const unknown = layer.find((e) => !KNOWN[e.role])
    if (unknown) t.check(rowOf(s, unknown.path).text.startsWith(unknown.role), `a role this page does not know shows its raw name: ${rowOf(s, unknown.path).text}`); else t.note('no root with an unknown role on this machine')
    const data = layer.find((e) => e.role === 'data')
    if (data) t.check(/free/.test(rowOf(s, data.path).trailing), `the data root shows its free space (${rowOf(s, data.path).trailing})`)
    // open a folder in each view
    const logs = layer.find((e) => e.role === 'logs') ?? layer[0]
    let got = await toggle(page, logs.path)
    t.check(got.ok && rowOf(got.state, logs.path).expanded === 'true' && under(got.state, logs.path).length > 0, `LayerFS folders: ${logs.path} opens (${under(got.state, logs.path).length} entries)`)
    await switchView(page, 'Whole filesystem (/)')
    s = await filesState(page)
    t.check(s.view === 'whole' && s.rows.some((r) => r.key === '/etc') && s.path === '/', `Whole filesystem lists / (${s.rows.length} entries, path bar "${s.path}")`)
    got = await toggle(page, '/etc')
    t.check(got.ok && under(got.state, '/etc').length > 0, '/etc opens')
    await shot(page, 'inspect-files-s2-whole')
    // back and forth: each view is where it was left
    await switchView(page, 'LayerFS folders')
    s = await filesState(page)
    t.check(s.view === 'layerfs' && s.base === '' && rowOf(s, logs.path)?.expanded === 'true' && under(s, logs.path).length > 0, 'back in LayerFS folders: its roots, with the folder still open')
    await switchView(page, 'Whole filesystem (/)')
    s = await filesState(page)
    t.check(s.view === 'whole' && s.base === '' && rowOf(s, '/etc')?.expanded === 'true' && under(s, '/etc').length > 0, 'back in Whole filesystem: /, with /etc still open')
    await goPath(page, '/usr')
    s = await filesState(page)
    t.check(s.view === 'whole' && s.base === '/usr', `Go to /usr makes it the tree's top (${s.base})`)
    await switchView(page, 'LayerFS folders')
    await switchView(page, 'Whole filesystem (/)')
    s = await filesState(page)
    t.check(s.view === 'whole' && s.base === '/usr' && s.path === '/usr', `and back again: still at /usr (${s.base})`)
    await files(page).locator('[data-files-crumbs] button').first().click()
    got = await waitFiles(page, (x) => x.base === '' && !!rowOf(x, '/etc'))
    t.check(got.ok, 'its breadcrumb goes back to /')
    // leaving the page and coming back: the last view and path
    await goPath(page, '/etc')
    await jump(page, m.title)
    await openPage(page, w)
    await showFiles(page)
    s = await filesState(page)
    t.check(s.view === 'whole' && s.base === '/etc', `reopened: the last view and path of this machine (${s.view} ${s.base})`)
    await switchView(page, 'LayerFS folders')
  })

  await run.row('S3', 'Sandbox Files: roots by role (Workspaces with chip, Home, log); Whole filesystem lists /; Browse base', async (t) => {
    const sb = need(T.sandbox)
    await openFiles(page, sb)
    let s = await filesState(page)
    const roots = await rootsOf(page, sb)
    const info = (await probe(page, 'GET', `/api/sandboxes/${enc(sb.name)}`)).body
    t.check((await tabs(page)).join('|') === 'Terminals|Files|Daemon log', `Sandbox tabs: ${JSON.stringify(await tabs(page))}`)
    const ws = roots.filter((e) => e.role === 'workspace'), home = roots.find((e) => e.role === 'home'), log = roots.find((e) => e.role === 'log')
    t.check(ws.length === info.workspaces.length && home && log, `the roots: ${ws.length} Workspaces, Home, log`)
    t.check(s.rows.filter((r) => !r.key.startsWith(`${home.path}/`)).every((r, i) => r.key === roots.filter((e) => e.path !== '/')[i].path), 'roots keep the server\'s order')
    for (const e of ws) {
      const r = rowOf(s, e.path), w = info.workspaces.find((x) => x.path === e.path || x.wsId === e.workspace)
      t.check(r && r.text.startsWith(`Workspace ${w?.name}`) && r.disabled && r.expanded === null, `Workspace ${w?.name}: a row without a chevron, named by the Workspace (${r?.text.slice(0, 40)})`)
      t.check(/Live files are in the terminal; saved files under Browse base/.test(r.below) && /Open terminal/.test(r.below), `…with the line about live and saved files and Open terminal`)
      const dirty = (w?.dirty?.inodes ?? 0) + (w?.dirty?.entries ?? 0)
      t.check(r.trailing !== '' && (dirty ? /uncommitted|change/.test(r.trailing) : true), `…and its changes chip (${r.trailing}; ${dirty ? 'dirty' : 'clean'})`)
      t.check(/Browse base/.test(r.below.replace('saved files under Browse base', '')) === !!w?.base, `…Browse base ${w?.base ? 'shown (it has a base Commit)' : 'hidden (no base)'}`)
    }
    t.check(rowOf(s, home.path).text.startsWith('Home') && rowOf(s, home.path).expanded !== null, 'Home is a folder row')
    t.check(rowOf(s, log.path).text.startsWith('Daemon log'), `the log row reads Daemon log (${rowOf(s, log.path).text.slice(0, 30)})`)
    const offersWhole = roots.some((e) => e.path === '/')
    t.check(offersWhole ? s.views.join('|') === 'Sandbox|Whole filesystem (/)' : s.views.length === 0, `${offersWhole ? 'the switch reads Sandbox | Whole filesystem (/)' : 'no / offered: no view switch'} (${JSON.stringify(s.views)})`)
    await shot(page, 'inspect-files-s3-sandbox')
    // Home opens
    let got = await toggle(page, home.path)
    t.check(got.ok && rowOf(got.state, home.path).expanded === 'true', 'Home opens')
    // Browse base
    const based = ws.map((e) => ({ e, w: info.workspaces.find((x) => x.path === e.path) })).find((x) => x.w?.base)
    if (based) {
      await itemOf(page, based.e.path).getByRole('button', { name: 'Browse base', exact: true }).click()
      const browse = files(page).locator('[data-files-browse], :scope[data-files-browse]')
      await page.waitForFunction(() => [...document.querySelectorAll('[data-storage-page] [data-files-browse]')].some((e) => e.offsetParent), null, { timeout: 15000 })
      const at = await page.evaluate(() => [...document.querySelectorAll('[data-storage-page] [data-files-browse]')].find((e) => e.offsetParent).getAttribute('data-files-browse'))
      t.check(at === based.w.base, `Browse base opens the project's saved files at the Workspace's base ${String(based.w.base).slice(0, 12)} (${String(at).slice(0, 12)})`)
      const text = await editor(page).locator('[data-files-browse]').innerText()
      t.check(/base, without live changes/.test(text), 'labelled "base, without live changes"')
      await editor(page).locator('[data-files-browse] [role=tree] [role=treeitem]').first().waitFor({ timeout: 15000 }).catch(() => t.check(false, 'the saved files tree does not list'))
      await shot(page, 'inspect-files-s3-base')
      await editor(page).getByRole('button', { name: 'Back to Files', exact: true }).click()
      got = await waitFiles(page, (x) => x.state === 'ready' && rowOf(x, home.path)?.expanded === 'true')
      t.check(got.ok, 'Back to Files: the tree as it was left')
      void browse
    } else t.note('no Workspace with a base Commit: Browse base was not opened')
    // Open terminal: the Terminals tab at that Workspace (the last one: past page 1 when there are more than four)
    const last = ws.at(-1), lastWs = info.workspaces.find((x) => x.path === last.path)
    await itemOf(page, last.path).getByRole('button', { name: 'Open terminal', exact: true }).click()
    await editor(page).getByRole('textbox', { name: `Command for ${lastWs.name}`, exact: true }).waitFor({ timeout: 15000 }).catch(() => t.check(false, `Open terminal does not show ${lastWs.name}'s pane`))
    t.check((await editor(page).getByRole('tab', { name: 'Terminals', exact: true }).getAttribute('aria-selected')) === 'true', 'Open terminal: the Terminals tab')
    // the log row
    await showFiles(page)
    await row(page, log.path).click()
    await editor(page).locator('[data-log]').waitFor({ timeout: 10000 }).catch(() => t.check(false, 'the log row does not open the Daemon log tab'))
    t.check((await editor(page).getByRole('tab', { name: 'Daemon log', exact: true }).getAttribute('aria-selected')) === 'true', 'the log row opens the Daemon log tab')

    // a Sandbox with `/`
    if (!T.wholeSandbox.name) { t.note('INSPECT_WHOLE_SANDBOX is not set: the Whole filesystem part was NOT_RUN'); return }
    const w = T.wholeSandbox
    await openFiles(page, w)
    s = await filesState(page)
    t.check(s.views.join('|') === 'Sandbox|Whole filesystem (/)', `${w.name}: the switch reads Sandbox | Whole filesystem (/) (${JSON.stringify(s.views)})`)
    await switchView(page, 'Whole filesystem (/)')
    s = await filesState(page)
    t.check(s.view === 'whole' && s.rows.length > 0 && s.rows.every((r) => /^\/[^/]+$/.test(r.key)), `Whole filesystem lists / (${s.rows.map((r) => r.key).join(' ')})`)
    await shot(page, 'inspect-files-s3-whole')
    await switchView(page, 'Sandbox')
  })

  await run.row('S4', 'Go to a pasted path opens it; a stored place opens at its path (Doctor "Show in Files": NOT_RUN, #180)', async (t) => {
    const target = T.wholeMachine.name ? T.wholeMachine : need(T.sandbox)
    const base = baseOf(target)
    await openFiles(page, target)
    if (target === T.wholeMachine) await switchView(page, 'Whole filesystem (/)')
    // a file, pasted as a terminal prints it: quoted, with blanks around
    await goPath(page, `  '${base}/sub/deep/file.txt' `)
    let got = await waitFiles(page, (s) => s.file === `${base}/sub/deep/file.txt` && /deep file/.test(s.viewer ?? ''))
    t.check(got.ok, `a pasted file path opens the file (file ${got.state.file}, viewer "${(got.state.viewer ?? '').slice(0, 40)}")`)
    t.check(got.state.base === `${base}/sub/deep` && rowOf(got.state, `${base}/sub/deep/file.txt`)?.selected, `…in its folder, selected in the tree (top ${got.state.base})`)
    t.check(got.state.path === `${base}/sub/deep/file.txt`, `the path bar shows it (${got.state.path})`)
    // a folder, with a trailing slash and doubled slashes
    await goPath(page, `${base}//sub/`)
    got = await waitFiles(page, (s) => s.base === `${base}/sub` && !!rowOf(s, `${base}/sub/deep`))
    t.check(got.ok, `a pasted folder path lists the folder (top ${got.state.base})`)
    t.check(/sub/.test(got.state.crumbs ?? ''), `with a breadcrumb back (${got.state.crumbs})`)
    // not a path the calls take
    await goPath(page, 'sub/deep', { wait: false })
    await sleep(300)
    const alert = await files(page).getByRole('alert').first().textContent().catch(() => null)
    t.check(alert === 'A path here starts with /.', `a path that is not absolute is refused in the page, without a read ("${alert}")`)
    await shot(page, 'inspect-files-s4')
    // the receiving side of "Show in Files": a stored { view, path } opens there
    await page.evaluate(({ kind, name, view, path }) => {
      const all = JSON.parse(localStorage.getItem('dsh-layerfs:inspect-files') ?? '{}')
      all[`${kind}:${name}`] = { view, path }
      localStorage.setItem('dsh-layerfs:inspect-files', JSON.stringify(all))
    }, { kind: target.kind, name: target.name, view: target === T.wholeMachine ? 'whole' : 'layerfs', path: `${base}/notes.txt` })
    await page.reload({ waitUntil: 'networkidle' })
    const { track, center } = await import('./e2e-inspect-files-lib.mjs')
    await track(page); await center(page)
    await openPage(page, target)
    await showFiles(page)
    got = await waitFiles(page, (s) => s.file === `${base}/notes.txt` && (s.viewer ?? '').includes('second line of notes'), { timeout: 15000 })
    t.check(got.ok, `a stored place opens the tab at its path (view ${got.state?.view}, file ${got.state?.file})`)
    t.note('Doctor finding → Show in Files: NOT_RUN (the link is #180\'s; context.tsx View carries { tab, view, path } and go() stores the place this row just read)')
    void NOTES
  })

  await run.row('P4', '3,000-entry folder pages with More entries; a 50 MB file pages by window; a deadline page reads "Stopped at the time limit"', async (t) => {
    const target = T.wholeMachine.name ? T.wholeMachine : need(T.sandbox)
    const base = baseOf(target)
    await openFiles(page, target)
    if (target === T.wholeMachine) await switchView(page, 'Whole filesystem (/)')
    await goPath(page, base)
    // the 3,000-entry folder
    const many = `${base}/many`
    const mark = spawnMark()
    let got = await toggle(page, many)
    let n = under(got.state, many).length
    t.check(got.ok && n > 0 && n < MANY, `the first page of ${MANY} entries is a page, not the folder (${n})`)
    t.check(moreOf(got.state, many)?.text === 'More entries', `a full page ends with "More entries" (${moreOf(got.state, many)?.text})`)
    const first = n
    let clicks = 0
    const t0 = Date.now()
    while (n < MANY && clicks < 12) {
      await moreButton(page, many).click()
      clicks++
      got = await waitFiles(page, (s) => under(s, many).length > n && !moreOf(s, many)?.text.includes('Reading'), { timeout: 15000 })
      if (!got.ok) break
      n = under(got.state, many).length
    }
    t.check(n === MANY && !moreOf(got.state, many), `all ${MANY} entries after ${clicks} × More entries (${n}), then no More row`)
    const keys = under(got.state, many).map((r) => r.key)
    t.check(new Set(keys).size === MANY && keys.every((k, i) => k === `${many}/e${String(i).padStart(4, '0')}`), 'every entry once, in the server\'s order')
    t.note(`pages of ${first}; ${clicks} more pages in ${Date.now() - t0} ms`)
    const ms = await page.evaluate(() => new Promise((resolve) => { const a = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - a))) }))
    t.check(ms < 500, `the page still draws with ${MANY} rows (two frames in ${Math.round(ms)} ms)`)
    if (spawns()) {
      const made = filesSpawns(spawnsSince(mark))
      t.check(made.length === clicks + 1 && made.slice(1).every((x) => x.argv.includes('--cursor')), `one read per page, each later one by --cursor (${made.length} reads)`)
    }
    await toggle(page, many)
    // the deadline page
    const slow = `${base}/slow`
    filesDriver.deadline(target, slow, 15)
    got = await toggle(page, slow)
    n = under(got.state, slow).length
    t.check(got.ok && n > 0 && n < SLOW, `a page cut short by time shows what it has (${n} of ${SLOW})`)
    t.check(moreOf(got.state, slow)?.text === 'Stopped at the time limit — Show more', `and reads "Stopped at the time limit — Show more" (${moreOf(got.state, slow)?.text})`)
    await shot(page, 'inspect-files-p4-deadline')
    for (let i = 0; i < 6 && moreOf(got.state, slow); i++) {
      const had = under(got.state, slow).length
      await moreButton(page, slow).click()
      got = await waitFiles(page, (s) => under(s, slow).length > had, { timeout: 15000 })
    }
    t.check(under(got.state, slow).length === SLOW && !moreOf(got.state, slow), `Show more reads on to the end (${under(got.state, slow).length})`)
    await toggle(page, slow)
    // the 50 MB file
    const big = `${base}/big.log`
    const fmark = spawnMark()
    const f0 = Date.now()
    await row(page, big).click()
    got = await waitFiles(page, (s) => s.file === big && /line 0000000 /.test(s.viewer ?? ''), { timeout: 15000 })
    t.check(got.ok, `the 50 MB file opens on its first window (${Date.now() - f0} ms)`)
    const linesShown = async () => Number(/Showing lines 1–([\d,]+)/.exec(await files(page).locator('[data-files-viewer]').innerText())?.[1].replace(/,/g, '') ?? 0)
    const one = await linesShown()
    t.check(one > 0 && one * 64 < BIG_BYTES / 10, `a window, not the file: ${one} lines of ${BIG_BYTES / 64}`)
    await files(page).getByRole('button', { name: 'Show more lines', exact: true }).click()
    await page.waitForFunction((one) => { const m = /Showing lines 1–([\d,]+)/.exec(document.querySelector('[data-storage-page] [data-files-viewer]')?.innerText ?? ''); return m && Number(m[1].replace(/,/g, '')) > one }, one, { timeout: 15000 }).catch(() => {})
    const two = await linesShown()
    t.check(two === one * 2, `Show more lines adds the next window (${one} → ${two})`)
    const text = await files(page).locator('[data-files-viewer]').innerText()
    t.check(text.includes(`line ${String(one).padStart(7, '0')} `) && text.includes(`line ${String(two - 1).padStart(7, '0')} `), 'the second window continues where the first ended')
    if (spawns()) {
      const made = filesSpawns(spawnsSince(fmark))
      t.check(made.length === 2 && made[1].argv.includes('--offset'), `two reads, the second by --offset (${made.map((x) => x.argv.slice(3).join(' ')).join(' ; ')})`)
    }
    await shot(page, 'inspect-files-p4-file')
    void cfg; void NotRun; void openPage
  })
})
