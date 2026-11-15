#!/usr/bin/env node
// The Files tabs without a mouse, for a screen reader, and on a narrow screen
// (layerfs-project#178 matrix):
//   S5  keyboard-only tree (one roving tab stop, arrows, Home/End, type-ahead, Enter) and axe on both Files tabs
//   S6  width ≤560 px: Files drills in one folder per screen, no horizontal scroll
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… INSPECT_SANDBOX=… [INSPECT_WHOLE_MACHINE=…] \
//     [INSPECT_STANDIN_DIR=… | INSPECT_FILES_BASE_<TARGET>=…] node test/e2e-inspect-files-axe.mjs [--rows S5,S6]
// Environment, material and what every row also checks: test/e2e-inspect-files-lib.mjs.
import { createRequire } from 'node:module'
import { T, baseOf, editor, files, filesState, forgetPlace, goPath, main, need, openFiles, row, rowOf, setup, shot, sleep, switchView, toRoots, toggle, under, waitFiles } from './e2e-inspect-files-lib.mjs'

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js')
/** Run axe on the open page; each violation node says whether it is in the Files tab or the tab bar. */
async function axe(page) {
  if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ path: axePath })
  return page.evaluate(async () => {
    const root = [...document.querySelectorAll('[data-storage-page]')].find((e) => e.offsetParent)
    const result = await window.axe.run(root, { resultTypes: ['violations'] })
    return {
      version: window.axe.version, passes: result.passes.length,
      violations: result.violations.map((v) => ({
        id: v.id, impact: v.impact, help: v.help,
        nodes: v.nodes.map((n) => {
          const el = document.querySelector(n.target[0])
          return { target: n.target.join(' '), html: n.html.slice(0, 160), fresh: !!el && (!!el.closest('[data-files]') || !!el.closest('[role=tablist]') || el.getAttribute('role') === 'tabpanel'), summary: (n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 200) }
        }),
      })),
    }
  })
}
/** The tree row that has the focus, and how many rows are tab stops. */
const focus = (page) => page.evaluate(() => {
  const tree = [...document.querySelectorAll('[data-storage-page] [data-files-tree]')].find((e) => e.offsetParent)
  const a = document.activeElement
  return { key: a?.getAttribute?.('data-tree-key') ?? null, inTree: !!a && !!tree?.contains(a), stops: [...(tree?.querySelectorAll('[data-tree-key]') ?? [])].filter((b) => b.tabIndex === 0).length, tag: a?.tagName ?? null, label: a?.getAttribute?.('aria-label') ?? a?.textContent?.slice(0, 40) ?? null }
})

setup()
await main('e2e-inspect-files-axe', async ({ run, page }) => {
  await forgetPlace(page)

  await run.row('S5', 'keyboard-only tree (roving tab stop, arrows, type-ahead) and screen-reader names (axe) on both Files tabs', async (t) => {
    const sb = need(T.sandbox)
    const base = baseOf(sb)
    const elsewhere = new Map()
    let version = ''
    const scan = async (state) => {
      const result = await axe(page)
      version = result.version
      let fresh = 0
      for (const v of result.violations) for (const n of v.nodes) {
        if (n.fresh) { fresh++; t.check(false, `${state}: ${v.id} (${v.impact}) ${v.help} — ${n.target} — ${n.html} — ${n.summary}`) } else elsewhere.set(`${v.id} ${n.target}`, `${v.id} (${v.impact}) ${v.help} — ${n.target}`)
      }
      t.note(`${state}: ${fresh} violations in the Files tab and tab bar, ${result.violations.reduce((n, v) => n + v.nodes.filter((x) => !x.fresh).length, 0)} elsewhere on the page (${result.passes} rules passed)`)
    }

    // ---- the Sandbox's Files tab, by keys only from the tab bar on
    await openFiles(page, sb)
    await scan('Sandbox Files, roots (Workspace rows, Home, log)')
    await goPath(page, base)
    await waitFiles(page, (s) => s.base === base && s.rows.length >= 8)
    // Tab from the filter reaches the tree in one stop, and the next Tab leaves it
    await files(page).getByRole('textbox', { name: 'Filter loaded entries' }).focus()
    await page.keyboard.press('Tab')
    let f = await focus(page)
    const names = (await filesState(page)).rows.map((r) => r.key)
    t.check(f.inTree && f.key === names[0] && f.stops === 1, `Tab from the filter lands on the tree's first row, the tree's one tab stop (${f.key?.split('/').pop()}, ${f.stops} stop)`)
    await page.keyboard.press('Tab')
    t.check(!(await focus(page)).inTree, 'the next Tab leaves the tree')
    await page.keyboard.press('Shift+Tab')
    f = await focus(page)
    t.check(f.inTree && f.key === names[0], 'Shift+Tab comes back to the same row')
    // arrows, End, Home
    await page.keyboard.press('ArrowDown')
    t.check((await focus(page)).key === names[1], `↓ moves to the next row (${(await focus(page)).key?.split('/').pop()})`)
    await page.keyboard.press('End')
    t.check((await focus(page)).key === names.at(-1), `End goes to the last row (${(await focus(page)).key?.split('/').pop()})`)
    await page.keyboard.press('ArrowUp')
    t.check((await focus(page)).key === names.at(-2), '↑ moves up one')
    await page.keyboard.press('Home')
    t.check((await focus(page)).key === names[0] && (await focus(page)).stops === 1, 'Home goes to the first row; still one tab stop')
    // type-ahead
    await sleep(1100)
    await page.keyboard.type('su')
    f = await focus(page)
    t.check(f.key === `${base}/sub`, `typing "su" goes to sub (${f.key?.split('/').pop()})`)
    // → opens a folder, → again steps into it, ← steps out and closes
    await page.keyboard.press('ArrowRight')
    let got = await waitFiles(page, (s) => rowOf(s, `${base}/sub`)?.expanded === 'true' && under(s, `${base}/sub`).length > 0)
    t.check(got.ok, '→ opens the folder')
    await page.keyboard.press('ArrowRight')
    t.check((await focus(page)).key === `${base}/sub/deep`, `→ again steps into it (${(await focus(page)).key?.split('/').pop()})`)
    await page.keyboard.press('ArrowLeft')
    t.check((await focus(page)).key === `${base}/sub`, '← steps out to the folder')
    await page.keyboard.press('ArrowLeft')
    got = await waitFiles(page, (s) => rowOf(s, `${base}/sub`)?.expanded === 'false')
    t.check(got.ok && (await focus(page)).key === `${base}/sub`, '← again closes it, the focus stays on it')
    // Enter opens a file; a disabled row takes the focus and opens nothing
    await sleep(1100)
    await page.keyboard.type('notes')
    t.check((await focus(page)).key === `${base}/notes.txt`, 'typing "notes" goes to notes.txt')
    await page.keyboard.press('Enter')
    got = await waitFiles(page, (s) => s.file === `${base}/notes.txt` && (s.viewer ?? '').includes('second line of notes'))
    t.check(got.ok && rowOf(got.state, `${base}/notes.txt`).selected, 'Enter opens the file; its row is aria-selected')
    t.check((await focus(page)).key === `${base}/notes.txt`, 'the focus stays in the tree')
    await sleep(1100)
    await page.keyboard.type('pipe')
    f = await focus(page)
    t.check(f.key === `${base}/pipe`, 'a row that cannot be opened is reached by the keys (pipe)')
    await page.keyboard.press('Enter')
    await sleep(300)
    t.check((await filesState(page)).file === `${base}/notes.txt`, 'Enter on it opens nothing')
    await scan('Sandbox Files, a folder with a file open')
    // a folder being read is aria-busy (checked while its read waits in P7); here: a closed folder is not
    t.check((await filesState(page)).rows.every((r) => !r.busy), 'no row is aria-busy when nothing is being read')
    // the path bar by keys: type, Enter
    const bar = files(page).getByRole('textbox', { name: 'Path', exact: true })
    await bar.focus()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type(`${base}/sub/deep`)
    await page.keyboard.press('Enter')
    got = await waitFiles(page, (s) => s.base === `${base}/sub/deep`)
    t.check(got.ok, 'the path bar: type a path and Enter goes there')
    await shot(page, 'inspect-files-s5-sandbox')

    // ---- the machine's Files tab
    const m = T.wholeMachine.name ? T.wholeMachine : need(T.machine)
    await openFiles(page, m)
    await scan(`machine ${m.name} Files, LayerFS folders`)
    if ((await filesState(page)).views.length === 2) {
      await switchView(page, 'Whole filesystem (/)')
      await toggle(page, '/etc')
      await scan(`machine ${m.name} Files, Whole filesystem with locked, system and link rows`)
      await goPath(page, '/nope/not/here')
      await waitFiles(page, (s) => s.notice !== null)
      await scan(`machine ${m.name} Files, with the fallback notice`)
      // the view switch by keys
      const sw = await page.evaluate(() => { const el = [...document.querySelectorAll('[data-storage-page] [data-files] input[type=radio], [data-storage-page] [data-files] [role=radio], [data-storage-page] [data-files] [role=tab]')].find((e) => e.offsetParent || e.type === 'radio'); el?.focus(); return el ? el.tagName + (el.getAttribute('role') ?? el.type ?? '') : null })
      if (sw) {
        await page.keyboard.press('ArrowLeft')
        const got2 = await waitFiles(page, (s) => s.view === 'layerfs', { timeout: 4000 })
        if (!got2.ok) { await page.keyboard.press('ArrowRight'); await page.keyboard.press('Space') }
        const now = await waitFiles(page, (s) => s.view === 'layerfs', { timeout: 4000 })
        t.check(now.ok, `the view switch works by keys (${sw})`)
      } else t.check(false, 'the view switch has no focusable control')
    }
    await shot(page, 'inspect-files-s5-machine')
    if (elsewhere.size) t.note(`not from this work (parts of the page that were there before): ${[...elsewhere.values()].join(' ; ').slice(0, 600)}`)
    t.note(`axe-core ${version}`)
    void editor; void row
  })

  await run.row('S6', 'width ≤560 px: Files drills in one folder per screen, no horizontal scroll', async (t) => {
    const sb = need(T.sandbox)
    const base = baseOf(sb)
    const size = page.viewportSize()
    // the app's own bar has no "Jump to" at this width: pages are opened wide, then narrowed
    const narrowTo = async (target) => { await page.setViewportSize(size); await openFiles(page, target); await toRoots(page); await page.setViewportSize({ width: 560, height: 800 }); await waitFiles(page, (x) => x.narrow && x.state === 'ready') }
    try {
      const noScroll = async (where) => {
        const x = await page.evaluate(() => { const el = [...document.querySelectorAll('[data-storage-page] [data-files]')].find((e) => e.offsetParent); const doc = document.scrollingElement; const wide = [...el.querySelectorAll('*')].filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX !== 'hidden' && getComputedStyle(n).overflowX !== 'clip' && getComputedStyle(n).textOverflow !== 'ellipsis' && n.clientWidth > 0 && !n.closest('[data-files-viewer]')).map((n) => `${n.tagName}.${String(n.className).slice(0, 30)} ${n.scrollWidth}>${n.clientWidth}`); return { page: doc.scrollWidth - doc.clientWidth, pane: el.scrollWidth - el.clientWidth, right: Math.round(el.getBoundingClientRect().right), width: window.innerWidth, wide } })
        t.check(x.page <= 0 && x.pane <= 0 && x.right <= x.width && x.wide.length === 0, `${where}: no horizontal scroll (page +${x.page}px, pane +${x.pane}px, pane ends at ${x.right} of ${x.width}px${x.wide.length ? `, scrolling inside: ${x.wide.join(', ')}` : ''})`)
      }
      await narrowTo(sb)
      let s = await filesState(page)
      t.check(s.narrow, `at 560 px the Files tab is in its narrow layout`)
      t.check(s.rows.every((r) => r.expanded === null || r.expanded === 'false') && s.viewer === null, 'one list on the screen: the roots, no file pane beside it')
      await noScroll('the roots')
      await shot(page, 'inspect-files-s6-roots')
      // a folder is entered, not opened in place
      const home = s.rows.find((r) => /^Home/.test(r.text))
      await row(page, home.key).click()
      let got = await waitFiles(page, (x) => x.base === home.key && x.state === 'ready')
      t.check(got.ok && !rowOf(got.state, home.key), `a folder row drills in: the screen is now ${home.key.split('/').pop()}'s entries`)
      await goPath(page, base)
      got = await waitFiles(page, (x) => x.base === base && x.rows.length >= 8)
      await row(page, `${base}/sub`).click()
      got = await waitFiles(page, (x) => x.base === `${base}/sub` && !!rowOf(x, `${base}/sub/deep`))
      t.check(got.ok && got.state.rows.length === 1, `…one folder per screen (${got.state.rows.length} row in sub)`)
      await noScroll('a folder')
      // back goes one folder up
      const back = files(page).locator('[data-files-crumbs]').getByRole('button').first()
      t.check(/e2e-files/.test(await back.textContent()), `a Back button names the folder above (${await back.textContent()})`)
      await back.click()
      got = await waitFiles(page, (x) => x.base === base)
      t.check(got.ok, 'and goes there')
      // a file takes the screen, with a way back
      await row(page, `${base}/notes.txt`).click()
      got = await waitFiles(page, (x) => x.file === `${base}/notes.txt` && (x.viewer ?? '').includes('second line of notes'))
      t.check(got.ok && got.state.rows.length === 0, 'a file takes the screen (the list is not beside it)')
      await noScroll('a file')
      await shot(page, 'inspect-files-s6-file')
      await files(page).getByRole('button', { name: /^Back to / }).first().click()
      got = await waitFiles(page, (x) => x.file === '' && x.base === base && x.rows.length >= 8)
      t.check(got.ok, 'Back returns to its folder')
      // the long path of a Workspace row and the path bar stay inside
      if (T.wholeMachine.name) {
        await narrowTo(T.wholeMachine)
        await noScroll('the machine\'s roots with the view switch')
        await switchView(page, 'Whole filesystem (/)')
        await noScroll('Whole filesystem')
        await switchView(page, 'LayerFS folders')
        await shot(page, 'inspect-files-s6-machine')
      }
      // wide again: the two panes come back
      await page.setViewportSize(size)
      await openFiles(page, sb)
      s = await filesState(page)
      t.check(!s.narrow, 'at the usual width the tree and the file are side by side again')
    } finally { await page.setViewportSize(size) }
  })
})
