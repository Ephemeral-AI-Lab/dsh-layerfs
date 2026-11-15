#!/usr/bin/env node
// The Doctor (Health) page's leftovers (layerfs-project#180 "dsh-layerfs UI"):
//   L1  every leftover finding of `layerfs doctor` is a row: machine, kind, path, size ("not measured" when
//       LayerFS gave none), age, and `layerfs doctor fix <id>` as text; an entry LayerFS only reports has no command
//   L2  the kinds LayerFS only counts (image locks, unmount markers) show as counts per machine with no command
//   L3  the command is copied as text; the page runs no `doctor fix`
//   S4  "Show in Files" opens the machine's Files tab at the leftover's path (the Doctor part of #178 S4);
//       the Files tree carries no leftover mark (D9)
//
// The rows compare the page with what `layerfs doctor` answers on the same
// home, so a real build needs leftovers on disk and no hook (the lib's header).
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… [INSPECT_STANDIN_DIR=…] node test/e2e-inspect-observe-doctor.mjs
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { NotRun, cfg, cli, editor, features, filesState, main, openHealth, setupObserve, shot, sleep, spawns, waitFiles } from './e2e-inspect-observe-lib.mjs'

const KIND = {
  'run-folder': 'Sandbox run folder with no record', 'empty-root': 'Empty Sandbox root', 'init-copy': 'Folder copy of a project init',
  'backup-staging': 'Staged backup snapshot', 'image-tmp': 'Temporary image unpack folder', 'image-part': 'Partly received image',
}
const placeOf = (machine) => (machine === 'native' ? 'LayerFS Home' : machine)

/** The leftover rows and the kept counts as the page shows them. */
const leftovers = (page) => page.evaluate(() => {
  const root = [...document.querySelectorAll('[data-storage-page]')].find((e) => e.offsetParent)
  const section = root?.querySelector('[data-leftovers]')
  if (!section) return null
  return {
    title: section.querySelector('h2')?.textContent ?? null,
    count: section.querySelector('h2')?.parentElement?.querySelector('span')?.textContent ?? null,
    rows: [...section.querySelectorAll('[data-leftover]')].map((el) => ({
      id: el.getAttribute('data-leftover'), kind: el.getAttribute('data-leftover-kind'), machine: el.getAttribute('data-leftover-machine'),
      text: el.innerText, path: el.querySelector('[data-leftover-path]')?.textContent ?? null,
      size: el.querySelector('[data-leftover-size]')?.getAttribute('data-leftover-size') ?? null, sizeText: el.querySelector('[data-leftover-size]')?.textContent ?? null,
      age: el.querySelector('[data-leftover-age]')?.getAttribute('data-leftover-age') ?? null, ageText: el.querySelector('[data-leftover-age]')?.textContent ?? null,
      command: el.querySelector('[data-leftover-fix] code')?.textContent ?? null,
      copy: el.querySelector('[data-leftover-fix] button')?.getAttribute('aria-label') ?? null,
      reportOnly: el.querySelector('[data-leftover-report-only]')?.textContent ?? null,
      condition: el.querySelector('[data-leftover-condition]')?.textContent ?? null,
      notBefore: el.querySelector('[data-leftover-not-before]')?.textContent ?? null,
      show: [...el.querySelectorAll('button')].some((b) => b.textContent === 'Show in Files'),
      noFiles: el.querySelector('[data-leftover-files]')?.textContent ?? null,
      buttons: [...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent),
    })),
    kept: [...section.querySelectorAll('[data-leftover-walk]')].map((el) => ({
      machine: el.getAttribute('data-leftover-walk'), locks: Number(el.getAttribute('data-image-locks')), markers: Number(el.getAttribute('data-unmount-markers')),
      text: el.textContent, incomplete: !!el.querySelector('[data-leftover-incomplete]'), buttons: el.querySelectorAll('button').length, code: el.querySelectorAll('code').length,
    })),
  }
})
async function waitLeftovers(page, timeout = 20000) {
  const until = Date.now() + timeout
  for (;;) { const got = await leftovers(page); if (got || Date.now() > until) return got; await sleep(200) }
}
const fixCalls = () => (spawns() ?? []).filter((s) => s.argv[0] === 'doctor' && s.argv[1] === 'fix').length

await main('e2e-inspect-observe-doctor', async ({ run, page }) => {
  setupObserve()
  const has = await features(page)
  const report = cli('doctor')
  const left = (report.findings ?? []).filter((f) => f.leftover)
  const need = () => {
    if (!has.leftovers) throw new NotRun('the pinned CLI has no doctor.fix: the page shows no leftovers (e2e-inspect-observe-absent.mjs checks that)')
    if (!left.length) throw new NotRun('`layerfs doctor` reports no leftover on this home: make some first (the lib\'s header)')
  }

  await run.row('L1', 'every leftover finding is a row: machine, kind, path, size, age, the fix command as text', async (t) => {
    need()
    await openHealth(page)
    const got = await waitLeftovers(page)
    if (!t.check(!!got, 'the Health page has a "Left by interrupted operations" section')) return
    t.check(got.title === 'Left by interrupted operations' && got.count === String(left.length), `titled, with the number of leftovers (${got.title}, ${got.count} of ${left.length})`)
    t.check(JSON.stringify(got.rows.map((r) => r.id)) === JSON.stringify(left.map((f) => f.leftover.id)), `one row per leftover, in LayerFS's order, none merged (${got.rows.length} rows)`)
    const kinds = new Set()
    for (const f of left) {
      const l = f.leftover, r = got.rows.find((x) => x.id === l.id)
      if (!r) continue
      kinds.add(l.kind)
      t.check(r.machine === l.machine && r.text.includes(`on ${placeOf(l.machine)}`), `${l.id}: its machine (${placeOf(l.machine)})`)
      t.check(r.kind === l.kind && r.text.includes(KIND[l.kind] ?? l.kind), `${l.id}: its kind in words (${KIND[l.kind] ?? l.kind})`)
      t.check(r.path === l.path, `${l.id}: its path (${r.path})`)
      if (l.bytes == null) t.check(r.size === 'not-measured' && r.sizeText === 'Size not measured' && !/\b0 B\b/.test(r.sizeText), `${l.id}: a size LayerFS did not measure reads "Size not measured", not 0 ("${r.sizeText}")`)
      else t.check(r.size === String(l.bytes) && /^Size [\d.]+ (B|KB|MB|GB|TB)$/.test(r.sizeText), `${l.id}: its size (${l.bytes} bytes: "${r.sizeText}")`)
      t.check(r.age === String(l.age) && /last changed .+ ago|last changed just now/.test(r.ageText ?? ''), `${l.id}: its age (${l.age} s: "${r.ageText}")`)
      if (l.fixable === false) {
        t.check(r.command === null && r.copy === null && !!r.reportOnly, `${l.id}: LayerFS only reports it: no command, and the row says so ("${r.reportOnly}")`)
      } else {
        t.check(r.command === `layerfs doctor fix ${l.id}`, `${l.id}: the command is \`layerfs doctor fix <id>\` ("${r.command}")`)
        t.check(r.copy === `Copy the command layerfs doctor fix ${l.id}`, `${l.id}: its copy button is named after the command`)
      }
      t.check(!r.buttons.some((b) => /^(fix|remove|delete|run)\b/i.test(b ?? '')), `${l.id}: no button runs or removes anything (${JSON.stringify(r.buttons)})`)
      if (l.not_before && l.not_before > Date.now()) t.check(!!r.notBefore, `${l.id}: LayerFS refuses it before a time, and the row says when ("${r.notBefore}")`)
      // LayerFS's own condition, without repeating the command
      const said = String(f.fix ?? '').replace(/`/g, '')
      if (r.condition) t.check(said.toLowerCase().includes(r.condition.replace(/`/g, '').toLowerCase().slice(1, 40)), `${l.id}: the condition is LayerFS's sentence ("${r.condition}")`)
    }
    const all = Object.keys(KIND)
    t.note(`kinds on this home: ${[...kinds].join(', ')}${all.every((k) => kinds.has(k)) ? ' (every listed kind)' : ` — NOT on this home: ${all.filter((k) => !kinds.has(k)).join(', ')}`}`)
    if (cfg.standin) t.check(all.every((k) => kinds.has(k)), 'the stand-in declares one of every listed kind')
    t.note(`a size not measured: ${left.some((f) => f.leftover.bytes == null) ? 'checked' : 'none on this home'}; report-only: ${left.some((f) => f.leftover.fixable === false) ? 'checked' : 'none on this home'}`)
    // the generic findings list does not repeat them
    const elsewhere = await page.evaluate(() => { const root = [...document.querySelectorAll('[data-storage-page]')].find((e) => e.offsetParent); return [...root.querySelectorAll('li')].filter((li) => !li.closest('[data-leftovers]') && /doctor fix /.test(li.textContent)).length })
    t.check(elsewhere === 0, `no leftover is listed a second time among the other findings (${elsewhere})`)
    await shot(page, 'observe-doctor-leftovers')
  })

  await run.row('L2', 'counted kinds (image locks, unmount markers) show as counts per machine with no command', async (t) => {
    need()
    const walks = (report.leftovers ?? [])
    const counted = walks.filter((w) => w.image_locks > 0 || w.unmount_markers > 0 || w.complete === false)
    if (!counted.length) throw new NotRun('`layerfs doctor` counts no image lock or unmount marker on this home, and every walk was complete')
    await openHealth(page)
    const got = await waitLeftovers(page)
    if (!t.check(!!got, 'the leftovers section is there')) return
    t.check(JSON.stringify(got.kept.map((k) => k.machine)) === JSON.stringify(counted.map((w) => w.machine)), `one line per machine that has a count or an incomplete walk (${got.kept.map((k) => k.machine).join(', ')}); a machine with neither has none`)
    for (const w of counted) {
      const k = got.kept.find((x) => x.machine === w.machine)
      if (!k) continue
      t.check(k.locks === w.image_locks && k.markers === w.unmount_markers, `${w.machine}: ${w.image_locks} image locks, ${w.unmount_markers} unmount markers ("${k.text}")`)
      if (w.image_locks) t.check(new RegExp(`\\b${w.image_locks} image lock files?\\b`).test(k.text), `${w.machine}: the count of image lock files is in words`)
      if (w.unmount_markers) t.check(new RegExp(`\\b${w.unmount_markers} unmount markers?\\b`).test(k.text), `${w.machine}: the count of unmount markers is in words`)
      t.check(k.buttons === 0 && k.code === 0 && !/doctor fix/.test(k.text), `${w.machine}: no command and no button`)
      t.check(k.incomplete === (w.complete === false), `${w.machine}: ${w.complete === false ? 'the walk was not complete, and the line says so' : 'a complete walk has no such note'}`)
    }
    t.check(!got.rows.some((r) => r.kind === 'image-lock' || r.kind === 'unmount-marker'), 'no counted kind is a row of its own')
  })

  await run.row('L3', 'the fix command is copied as text; the page runs no `doctor fix`', async (t) => {
    need()
    const fixable = left.find((f) => f.leftover.fixable !== false)
    if (!fixable) throw new NotRun('no leftover on this home has a command')
    const before = fixCalls()
    await openHealth(page)
    await waitLeftovers(page)
    const row = editor(page).locator(`[data-leftover=${JSON.stringify(fixable.leftover.id)}]`)
    const command = `layerfs doctor fix ${fixable.leftover.id}`
    await page.evaluate(() => navigator.clipboard.writeText('nothing yet')).catch(() => {})
    await row.getByRole('button', { name: `Copy the command ${command}`, exact: true }).click()
    await row.getByRole('button', { name: 'Copied', exact: true }).waitFor({ timeout: 5000 }).catch(() => t.check(false, 'the button says "Copied"'))
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `clipboard not readable: ${e.message}`)
    t.check(clip === command, `the clipboard holds the command, nothing else ("${clip}")`)
    await sleep(1500)
    const asked = await page.evaluate(() => (window.__inspect?.calls ?? []).filter((c) => /doctor/.test(c.what) && !/^GET /.test(c.what) && !/^http GET /.test(c.what)).map((c) => c.what))
    t.check(asked.length === 0, `the click sent no write to the host (${JSON.stringify(asked)})`)
    if (spawns()) t.check(fixCalls() === before, `no \`doctor fix\` became a CLI process (${fixCalls() - before})`)
    else t.note('no spawn log: CLI processes were not counted')
    if (cfg.standin) t.check(!existsSync(join(cfg.standin, 'doctor-fix.log')), 'the stand-in was never asked `doctor fix`')
  })

  await run.row('S4', '"Show in Files" opens the machine\'s Files tab at the leftover\'s path (Doctor part of S4)', async (t) => {
    need()
    if (!has.inspect?.machineFiles) throw new NotRun('the pinned CLI has no machine.files: the link is replaced by its reason (e2e-inspect-observe-nofiles.mjs checks that)')
    // one leftover per machine that has any, a folder on disk where there is one
    const byMachine = new Map()
    for (const f of left) if (!byMachine.has(f.leftover.machine)) byMachine.set(f.leftover.machine, f.leftover)
    let opened = 0
    for (const l of byMachine.values()) {
      await openHealth(page)
      const got = await waitLeftovers(page)
      const r = got?.rows.find((x) => x.id === l.id)
      if (!t.check(!!r?.show && r.noFiles === null, `${l.id}: the row has "Show in Files"`)) continue
      await editor(page).locator(`[data-leftover=${JSON.stringify(l.id)}]`).getByRole('button', { name: 'Show in Files', exact: true }).click()
      const tab = editor(page).getByRole('tab', { name: 'Files', exact: true })
      const there = await tab.waitFor({ timeout: 15000 }).then(() => true, () => false)
      if (!t.check(there && (await tab.getAttribute('aria-selected')) === 'true', `${l.id}: the page of ${placeOf(l.machine)} opens on its Files tab`)) continue
      const done = await waitFiles(page, (s) => s.state !== 'reading' && s.state !== 'going', { timeout: 20000 })
      const s = done.state
      const heading = await editor(page).getByRole('heading', { level: 1 }).first().textContent()
      t.check(new RegExp(l.machine === 'native' ? 'LayerFS Home' : l.machine, 'i').test(heading ?? ''), `${l.id}: it is that machine's page ("${heading}")`)
      const at = s?.base === l.path || s?.file === l.path || s?.path === l.path
      if (at) { opened++; t.note(`${l.id}: the Files tab of ${placeOf(l.machine)} is at ${l.path} (view ${s.view}, top "${s.base}"${s.file ? `, file ${s.file}` : ''})`) } else if (s?.notice) {
        // a path the machine's files call cannot open: the tab falls back to the view's root and says why
        t.check(s.base === '' && s.notice.length > 0, `${l.id}: ${l.path} cannot be opened there; the tab is at the roots and says why ("${s.notice.slice(0, 120)}")`)
      } else if (s?.state === 'refused' && s.refusals.length) {
        // the machine's files call answers nothing at all (a stopped machine): the tab shows the refusal
        t.note(`${l.id}: the files call of ${placeOf(l.machine)} was refused; the tab shows it (${s.refusals[0].code})`)
      } else t.check(false, `${l.id}: the Files tab is neither at ${l.path} nor says why (${JSON.stringify({ base: s?.base, file: s?.file, path: s?.path, notice: s?.notice, state: s?.state })})`)
      // D9: the tree has no leftover tag
      const marks = await editor(page).locator('[data-files] [data-leftover], [data-files] [data-tree-leftover]').count()
      const words = (await filesState(page))?.rows.filter((x) => /leftover|doctor fix/i.test(x.text ?? '')).length ?? 0
      t.check(marks === 0 && words === 0, `${l.id}: the Files tree carries no leftover mark`)
      await shot(page, `observe-doctor-show-${l.machine}`)
    }
    t.check(opened > 0, `at least one leftover's path opened in a Files tab (${opened} of ${byMachine.size} machines)`)
  })
})
