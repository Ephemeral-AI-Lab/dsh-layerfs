#!/usr/bin/env node
// The project Files view on a private side server: the folder tree (lazy folders,
// kind-first order, "Show more entries" paging), the filter over opened folders,
// and the file viewer's Code view (line windows, binary notice). Written against
// the view before the shared FileTree was extracted (#179), so a refactor of
// src/client/files/{ProjectFiles,FileTree,FileViewer}.tsx must keep it passing.
//
//   DSH_LAYERFS_DEV_DIR=$PWD/.dev-m179 DSH_LAYERFS_CLI=<pinned cli> node test/e2e-file-tree.mjs
//     [--shots <dir>] [--dom <file>] [--keys] [--size 1280x820] [--headed]
//
// Seeds the project `e2etree/files` once in the server's private LayerFS home (a
// Store on the host machine and a folder of 1,200 files, a 6,000-line file, a binary file,
// an empty file and a symlink) with plain CLI calls; `node tools/cleanup-dev.mjs`
// removes it. After seeding, everything is a read: the tools/lfs-check.mjs
// snapshots before and after must not differ.
// --dom writes the expanded tree's markup (class names and structure) for a
// before/after comparison. --keys also checks the tree's keyboard model (one tab
// stop, arrows, Home/End, type-ahead, aria-busy), which the base view lacks.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDev } from '../tools/e2e-lib.mjs'
import { diff, formatDiff, privateHome, snapshot } from '../tools/lfs-check.mjs'

const argv = process.argv.slice(2)
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback }
const devDir = process.env.DSH_LAYERFS_DEV_DIR
const cli = process.env.DSH_LAYERFS_CLI
if (!devDir || !cli) { console.error('file-tree: set DSH_LAYERFS_DEV_DIR and DSH_LAYERFS_CLI (the side server\'s dev dir and pinned CLI)'); process.exit(2) }
const shots = opt('--shots', join(devDir, 'shots'))
mkdirSync(shots, { recursive: true })
const STORE = 'e2etree', PROJECT = 'files', MANY = 1200, LINES = 6000

const failures = []
const fail = (message) => { failures.push(message); console.error(`FAIL ${message}`) }
const check = (ok, message) => { if (!ok) fail(message) }

// ---------------------------------------------------------------- seed (once)
const home = privateHome(devDir)
const lfs = (...args) => JSON.parse(execFileSync(cli, args, { env: { ...process.env, LAYERFS_HOME: home }, encoding: 'utf8', timeout: 60_000 }))
const seeded = (lfs('project', 'list').items ?? []).some((p) => p.project === `${STORE}/${PROJECT}`)
if (!seeded) {
  const src = mkdtempSync(join(tmpdir(), 'dsh-e2e-tree-'))
  try {
    for (const dir of ['src/lib', 'docs', 'many/zz-sub']) mkdirSync(join(src, dir), { recursive: true })
    writeFileSync(join(src, 'README.md'), '# e2e tree\n\nA project for the Files view check.\n')
    writeFileSync(join(src, 'src/index.ts'), 'export const a = 1\n')
    writeFileSync(join(src, 'src/lib/util.ts'), 'export const b = 2\n')
    writeFileSync(join(src, 'docs/notes.md'), 'notes\n')
    for (let i = 0; i < MANY; i++) writeFileSync(join(src, 'many', `file-${String(i).padStart(4, '0')}.txt`), `entry ${i}\n`)
    writeFileSync(join(src, 'many/zz-sub/inner.txt'), 'inner\n')
    writeFileSync(join(src, 'big.txt'), Array.from({ length: LINES }, (_, i) => `line ${i + 1} of the big file, padded so a window ends before the file does\n`).join(''))
    writeFileSync(join(src, 'blob.bin'), Buffer.from(Array.from({ length: 16384 }, (_, i) => i % 256)))
    writeFileSync(join(src, 'empty.txt'), '')
    symlinkSync('README.md', join(src, 'link-to-readme'))
    if (!(lfs('store', 'list').items ?? []).some((s) => s.name === STORE)) lfs('store', 'create', STORE)
    lfs('project', 'init', `${STORE}/${PROJECT}`, src)
    console.log(`file-tree: seeded ${STORE}/${PROJECT} in ${home}`)
  } finally { rmSync(src, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------- browse
const before = await snapshot(devDir)
const { browser, page, logs } = await openDev({ headless: !argv.includes('--headed') })
page.setDefaultTimeout(15000)
const sleep = (ms) => page.waitForTimeout(ms)
try {
  const bar = page.locator('header[aria-label="Center navigation"]')
  await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'LayerFS', exact: true }).first().click()
  await bar.waitFor()
  // A project seeded a moment ago shows once the host's project list is read again (Refresh).
  const option = page.getByRole('listbox', { name: 'Jump to' }).getByRole('option').filter({ has: page.locator('span', { hasText: new RegExp(`^${PROJECT}$`) }) }).first()
  for (let attempt = 0; attempt < 6; attempt++) {
    await bar.getByRole('button', { name: /^Jump to/ }).click()
    await page.getByRole('combobox', { name: 'Jump to' }).fill(`${PROJECT} ${STORE}`)
    if (await option.waitFor({ timeout: 3000 }).then(() => true, () => false)) break
    await page.keyboard.press('Escape')
    await bar.getByRole('button', { name: 'Refresh', exact: true }).click().catch(() => {})
    await sleep(3000)
  }
  await option.click()
  const views = page.getByRole('tablist', { name: 'Project views' })
  await views.waitFor()
  await views.getByRole('tab', { name: 'Files', exact: true }).click()
  // A narrow window hides DSH's sidebar and panel buttons: navigate wide, then resize.
  const [width, height] = opt('--size', '1280x820').split('x').map(Number)
  await page.setViewportSize({ width, height })

  const side = page.getByRole('complementary', { name: 'Files' })
  const tree = side.getByRole('tree', { name: 'Files' })
  await tree.waitFor()
  /** The names of the rows showing, top to bottom (rows only: no notes, no "Show more entries"). */
  const rows = () => side.locator('[class*=treeName]').allTextContents()
  const row = (name) => tree.getByRole('treeitem').filter({ has: page.locator('[class*=treeName]', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).last().getByRole('button').first()
  const more = () => side.getByRole('button', { name: 'Show more entries', exact: true })
  const openTabs = () => page.getByRole('tablist', { name: 'Open files' }).getByRole('tab').allTextContents()

  // Root: folders first, then files, each by name (code units: capitals first); the README opens by itself.
  const root = await rows()
  check(JSON.stringify(root) === JSON.stringify(['docs', 'many', 'src', 'README.md', 'big.txt', 'blob.bin', 'empty.txt', 'link-to-readme']), `root rows: ${JSON.stringify(root)}`)
  await page.getByRole('tablist', { name: 'Open files' }).getByRole('tab').first().waitFor()
  check(JSON.stringify(await openTabs()) === JSON.stringify(['README.md']), `open tabs at start: ${JSON.stringify(await openTabs())}`)
  await page.screenshot({ path: join(shots, 'file-tree-root.png') })

  // A folder reads when it opens; nested folders too.
  await row('src').click()
  await row('lib').waitFor()
  await row('lib').click()
  await row('util.ts').waitFor()
  check(JSON.stringify(await rows()) === JSON.stringify(['docs', 'many', 'src', 'lib', 'util.ts', 'index.ts', 'README.md', 'big.txt', 'blob.bin', 'empty.txt', 'link-to-readme']), `rows with src/lib open: ${JSON.stringify(await rows())}`)
  check((await tree.getByRole('treeitem', { expanded: true }).count()) === 2, 'src and lib are aria-expanded')
  if (opt('--dom')) {
    // Structure and class names, without what a run changes (React ids, inline style spacing).
    const html = await side.evaluate((el) => el.querySelector('[role=tree]').outerHTML.replace(/ id="[^"]*"/g, '').replace(/></g, '>\n<'))
    writeFileSync(opt('--dom'), html)
  }
  await page.screenshot({ path: join(shots, 'file-tree-open.png') })

  // The filter lists matching files of the opened folders by path; Escape clears it.
  const find = side.getByRole('textbox', { name: 'Find in opened folders' })
  await find.fill('UTIL')
  const paths = side.locator('[class*=treePath]')
  await paths.first().waitFor()
  check(JSON.stringify(await paths.allTextContents()) === JSON.stringify(['/src/lib/util.ts']), `filter UTIL: ${JSON.stringify(await paths.allTextContents())}`)
  check((await side.getByRole('tree').count()) === 0, 'the filter replaces the tree')
  await page.screenshot({ path: join(shots, 'file-tree-filter.png') })
  await paths.first().click()
  check(JSON.stringify(await openTabs()) === JSON.stringify(['README.md', 'util.ts']), `open tabs after a filtered open: ${JSON.stringify(await openTabs())}`)
  await find.fill('src')
  await sleep(200)
  check(JSON.stringify(await paths.allTextContents()) === JSON.stringify(['/src/lib/util.ts', '/src/index.ts']) || JSON.stringify(await paths.allTextContents()) === JSON.stringify(['/src/index.ts', '/src/lib/util.ts']), `filter src lists files only: ${JSON.stringify(await paths.allTextContents())}`)
  await find.fill('no-such-name')
  await side.getByText('No file in the opened folders matches.', { exact: true }).waitFor().catch(() => fail('filter with no match: no note'))
  await find.press('Escape')
  await tree.waitFor()
  check((await find.inputValue()) === '', 'Escape clears the filter')
  check((await rows()).includes('util.ts'), 'the tree is back with its folders still open')

  // Closing a folder hides its rows and keeps what was read.
  await row('src').click()
  check(!(await rows()).includes('index.ts'), 'src closed')

  // A large folder: the first page, then each "Show more entries" appends the next one.
  await row('many').click()
  await more().waitFor()
  const count = async () => (await rows()).filter((n) => n.startsWith('file-')).length
  const pages = [await count()]
  check(pages[0] > 0 && pages[0] < MANY, `first page of many: ${pages[0]} rows`)
  await more().scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(shots, 'file-tree-more.png') })
  for (let i = 0; i < 12 && (await more().count()); i++) {
    const had = pages.at(-1)
    await more().click()
    await page.waitForFunction((n) => [...document.querySelectorAll('[role=tree] [class*=treeName]')].filter((el) => el.textContent.startsWith('file-')).length > n, had).catch(() => fail(`Show more entries: nothing after ${had} rows`))
    pages.push(await count())
    check(pages.at(-1) > had, `Show more entries appends: ${had} → ${pages.at(-1)}`)
  }
  console.log(`file-tree: many/ paged ${pages.join(' → ')}`)
  const all = await rows()
  check(pages.at(-1) === MANY, `after the last page: ${pages.at(-1)} rows`)
  check(new Set(all).size === all.length, 'no row twice')
  check(all[all.indexOf('many') + 1] === 'zz-sub', `folders stay first after paging: ${all.slice(all.indexOf('many'), all.indexOf('many') + 3)}`)
  check((await more().count()) === 0, 'no "Show more entries" after the last page')
  await row('many').click()

  if (argv.includes('--keys')) {
    // One tab stop; arrows, Home/End and type-ahead move it; Right/Left open, close and step in and out.
    const stops = () => tree.locator('button[tabindex="0"]').count()
    const focused = () => page.evaluate(() => document.activeElement?.querySelector?.('[class*=treeName]')?.textContent ?? document.activeElement?.textContent ?? null)
    check((await stops()) === 1, `one tab stop in the tree: ${await stops()}`)
    await row('docs').focus()
    await page.keyboard.press('ArrowDown'); check((await focused()) === 'many', `ArrowDown → ${await focused()}`)
    await page.keyboard.press('ArrowDown'); check((await focused()) === 'src', `ArrowDown → ${await focused()}`)
    await page.keyboard.press('ArrowRight'); await row('lib').waitFor(); check((await rows()).includes('index.ts'), 'ArrowRight opens a closed folder')
    await page.keyboard.press('ArrowRight'); check((await focused()) === 'lib', `ArrowRight on an open folder → ${await focused()}`)
    await page.keyboard.press('ArrowRight'); check((await focused()) === 'util.ts', `lib is still open, ArrowRight steps in → ${await focused()}`)
    await page.keyboard.press('ArrowLeft'); check((await focused()) === 'lib', `ArrowLeft on a file → its folder: ${await focused()}`)
    await page.keyboard.press('ArrowLeft'); check(!(await rows()).includes('util.ts'), 'ArrowLeft closes an open folder')
    await page.keyboard.press('ArrowLeft'); check((await focused()) === 'src', `ArrowLeft on a closed folder → its parent: ${await focused()}`)
    await page.keyboard.press('End'); check((await focused()) === 'link-to-readme', `End → ${await focused()}`)
    await page.keyboard.press('Home'); check((await focused()) === 'docs', `Home → ${await focused()}`)
    await page.keyboard.press('ArrowUp'); check((await focused()) === 'docs', `ArrowUp at the top stays: ${await focused()}`)
    await page.keyboard.type('bl'); check((await focused()) === 'blob.bin', `type-ahead "bl" → ${await focused()}`)
    await sleep(700)
    await page.keyboard.type('b'); check((await focused()) === 'big.txt', `type-ahead "b" from blob.bin wraps to ${await focused()}`)
    check((await stops()) === 1, `still one tab stop: ${await stops()}`)
    check((await tree.locator('button[tabindex="0"] [class*=treeName]').textContent()) === 'big.txt', 'the tab stop follows focus')
    await page.keyboard.press('Enter')
    await page.getByRole('tablist', { name: 'Open files' }).getByRole('tab', { name: 'big.txt' }).waitFor().catch(() => fail('Enter on a file row opens it'))
    await row('src').focus(); await page.keyboard.press('ArrowLeft')
    // A folder being read is aria-busy until its entries arrive.
    const busy = await page.evaluate(async () => {
      const item = [...document.querySelectorAll('[role=tree] [role=treeitem]')].find((li) => li.querySelector('[class*=treeName]')?.textContent === 'docs')
      let seen = false
      const watch = new MutationObserver((records) => { if (item.getAttribute('aria-busy') === 'true' || records.some((r) => r.oldValue === 'true')) seen = true })
      watch.observe(item, { attributes: true, attributeFilter: ['aria-busy'], attributeOldValue: true })
      item.querySelector('button').click()
      for (let i = 0; i < 100 && !item.querySelector('[role=group]'); i++) await new Promise((r) => setTimeout(r, 50))
      watch.disconnect()
      return { seen, after: item.getAttribute('aria-busy') }
    })
    check(busy.seen && busy.after !== 'true', `aria-busy while docs is read, cleared after: ${JSON.stringify(busy)}`)
  }

  // Code view: a long file shows its first window and reads the next on request.
  const viewer = page.locator('[class*=fileView]').first()
  await row('big.txt').click()
  const foot = viewer.getByText(/^Showing lines 1–\d+\.$/)
  await foot.waitFor()
  const shownBefore = Number((await foot.textContent()).match(/–(\d+)/)[1])
  check(shownBefore > 0 && shownBefore < LINES, `first window of big.txt: ${shownBefore} lines`)
  await page.screenshot({ path: join(shots, 'file-tree-window.png') })
  await viewer.getByRole('button', { name: 'Show more lines', exact: true }).click()
  await page.waitForFunction((n) => Number(document.querySelector('[class*=fileFoot] span')?.textContent?.match(/–(\d+)/)?.[1] ?? Infinity) > n, shownBefore).catch(() => fail('Show more lines: no second window'))
  const shownAfter = (await foot.count()) ? Number((await foot.textContent()).match(/–(\d+)/)[1]) : LINES
  check(shownAfter > shownBefore && shownAfter <= LINES, `second window of big.txt: ${shownBefore} → ${shownAfter}`)
  console.log(`file-tree: big.txt windows ${shownBefore} → ${shownAfter} of ${LINES} lines`)
  // Binary, empty and linked files show their states.
  await row('blob.bin').click()
  await viewer.getByText(/^Binary file · /).waitFor().catch(() => fail('blob.bin: no binary notice'))
  await row('empty.txt').click()
  await sleep(1200)
  check((await viewer.getByRole('alert').count()) === 0, 'empty.txt opens without a refusal')
  await page.screenshot({ path: join(shots, 'file-tree-end.png') })
  check(JSON.stringify(await openTabs()) === JSON.stringify(['README.md', 'util.ts', 'big.txt', 'blob.bin', 'empty.txt']), `open tabs at the end: ${JSON.stringify(await openTabs())}`)
} catch (error) {
  fail(`${error?.stack ?? error}`)
  await page.screenshot({ path: join(shots, 'file-tree-failure.png') }).catch(() => {})
} finally {
  await browser.close()
}

for (const line of logs) fail(`console ${line}`)
const state = diff(before, await snapshot(devDir))
console.log(formatDiff(state))
for (const f of state.failures) fail(`lfs-check ${f.kind}: ${f.message}`)
console.log(failures.length ? `file-tree: ${failures.length} failure(s)` : `file-tree: ok${argv.includes('--keys') ? ' (with keyboard checks)' : ''}`)
process.exit(failures.length ? 1 : 0)
