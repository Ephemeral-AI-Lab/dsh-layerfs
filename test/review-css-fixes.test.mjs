// Styling/layout review fixes (claude/review-css-fixes):
//  1. no plugin CSS or script reaches DSH's internals: no class-substring selector
//     ([class*=…] matches DSH's hashed CSS-module names and breaks silently when DSH
//     rebuilds), no walk up from the hero's brand-mark slot, no hiding of a DSH menu
//     row's trailing check; DSH primitives are styled through their props
//     (className, contentClassName, listClassName, selectedId) and our own classes;
//  2. one touch layout, `(pointer: coarse), (max-width: 834px)`, everywhere (a mouse
//     window wider than 834px keeps desktop sizing), equal to HistoryGraph's
//     TOUCH_QUERY, and no 44px chevron or row menu spills out of its table column;
//  3. the Files tree drawer is keyed on the Files container and covers only it,
//     focus moves into it on open and back to its toggle on close, and with no file
//     open the empty view offers the tree;
//  4. the Logs card layout keeps which client made each call;
//  5. the guide's CLI map names Buckets as Home's own tab.
// Each test fails on 9a0306b and passes after the fix.
//   node --test test/review-css-fixes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(join(root, p), 'utf8')
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n)
  return statSync(p).isDirectory() ? walk(p) : [p]
})
const clientFiles = walk(join(root, 'src/client'))
const sources = (ext) => clientFiles.filter((p) => ext.test(p)).map((p) => ({ path: relative(root, p), text: readFileSync(p, 'utf8') }))
const TOUCH = '(pointer: coarse), (max-width: 834px)'

/** The bodies of every `@<rule> <condition> { … }` block. */
const blocks = (css, head) => {
  const out = []
  for (let i = css.indexOf(head); i >= 0; i = css.indexOf(head, i + 1)) {
    let depth = 0, j = css.indexOf('{', i)
    const open = j
    for (; j < css.length; j++) { if (css[j] === '{') depth++; else if (css[j] === '}' && --depth === 0) break }
    out.push(css.slice(open + 1, j))
  }
  return out
}

// ---------------------------------------------------------------- 1. public seams only

// The one exception the user allowed (2026-11-28): the LayerFS view switch in
// DSH's Workspaces header, which has no slot. Nothing else may join this list.
const HEADER_SWITCH = ['src/client/projects/WorkspacesView.tsx', 'src/client/projects/workspaces.module.css']

test('no plugin stylesheet or script matches class names by substring (DSH hashed classes)', () => {
  const offenders = []
  for (const { path, text } of sources(/\.(css|tsx?)$/)) {
    if (HEADER_SWITCH.includes(path)) continue
    for (const [n, line] of text.split('\n').entries()) {
      if (/\[class\s*[*^$|~]?=/.test(line)) offenders.push(`${path}:${n + 1}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [], 'every DSH primitive is styled through its props or our own classes')
})

test('the hero leaves DSH\'s title and menu rows alone', () => {
  const tsx = read('src/client/hero/HeroProject.tsx')
  assert.doesNotMatch(tsx, /brand\.mark"\]'\)\?\.parentElement/, 'no walk up from the brand-mark slot to DSH\'s title')
  assert.doesNotMatch(tsx, /data-layerfs-hero-(title|headline)/)
  const css = read('src/client/hero/hero.module.css')
  assert.doesNotMatch(css, /svg:last-child/, 'DSH\'s trailing check is not hidden by its markup')
  assert.doesNotMatch(css, /data-layerfs-hero-(title|headline)/)
})

test('DSH modals: our scroll region rides contentClassName, our fields ride Input className', () => {
  const confirm = read('src/client/ui/ConfirmDialog.tsx')
  assert.match(confirm, /contentClassName=\{css\.confirmContent\}/)
  for (const [file, cls] of [['src/client/storage/parts.tsx', 'css'], ['src/client/storage/SandboxMachinePicker.tsx', 'css'], ['src/client/storage/BackupDialogs.tsx', 'scss']]) {
    assert.match(read(file), new RegExp(`className=\\{${cls}\\.modal\\} contentClassName=\\{${cls}\\.modalContent\\}`), `${file} scrolls through contentClassName`)
  }
  const storage = read('src/client/storage/Storage.module.css')
  assert.match(storage, /\.modalContent \{[^}]*overflow-y: auto/)
  assert.match(read('src/client/storage/parts.tsx'), /<Input className=\{clsx\(css\.fieldInput, mono && css\.monoInput\)\}/)
  // every DSH Input inside a machine page, panel or dialog carries ui's touchField class
  for (const { path, text } of sources(/machines\/[^/]+\.tsx$/)) {
    for (const m of text.matchAll(/<Input\s[^>]*?(?:\/>|>)/g)) {
      assert.match(m[0], /className=\{(touchField|clsx\(touchField,[^}]*\))\}/, `${path}: ${m[0].slice(0, 80)}`)
    }
  }
  const ui = read('src/client/ui/ui.module.css')
  assert.match(blocks(ui, `@media ${TOUCH} {`).join('\n'), /\.touchField \{\s*height: var\(--lfs-tap, 44px\);/)
})

// ---------------------------------------------------------------- 2. one touch layout

test('every touch media query is (pointer: coarse), (max-width: 834px)', () => {
  const css = sources(/\.css$/)
  const stale = []
  let touch = 0
  for (const { path, text } of css) {
    for (const m of text.matchAll(/@media\s*([^{]*)\{/g)) {
      const cond = m[1].trim()
      if (/pointer:\s*coarse/.test(cond)) {
        touch++
        if (cond !== TOUCH) stale.push(`${path}: @media ${cond}`)
      }
      if (/1180px/.test(cond)) stale.push(`${path}: @media ${cond}`)
    }
  }
  assert.deepEqual(stale, [], 'no mouse window up to 1180px gets the touch sizing')
  assert.ok(touch > 40, `the touch blocks are still there (${touch})`)
  const responsive = read('src/client/ui/responsive.css')
  const tokens = blocks(responsive, `@media ${TOUCH} {`).join('\n')
  assert.match(tokens, /--lfs-tap: 44px;/)
  assert.match(tokens, /--lfs-tap-track: 44px;/)
  assert.match(responsive.slice(0, responsive.indexOf('@media')), /--lfs-tap-track: 0px;/)
  assert.match(read('src/client/files/HistoryGraph.tsx'), new RegExp(`export const TOUCH_QUERY = '${TOUCH.replace(/[()]/g, '\\$&')}'`))
})

test('ProjectTable and the machines table: a 44px chevron or menu never spills out of its column', () => {
  const table = read('src/client/storage/ProjectTable.module.css')
  // On touch the toggle and every row button are 44px wide...
  const touch = blocks(table, `@media ${TOUCH} {`).join('\n')
  assert.match(touch, /\.toggle \{[^}]*width: var\(--lfs-tap, 44px\)/)
  assert.match(touch, /\.row button \{[^}]*min-width: var\(--lfs-tap, 44px\)/)
  // ...so the first and last tracks of every multi-column layout are at least the touch track.
  const tracks = [...table.matchAll(/grid-template-columns:\s*([^;]+);/g)].map((m) => m[1].replace(/\s+/g, ' ').trim())
    .filter((t) => t !== 'subgrid' && t !== 'minmax(0, 1fr)' && !t.startsWith('14px'))
  assert.ok(tracks.length >= 5, tracks.join('\n'))
  for (const t of tracks) {
    assert.match(t, /^(var\(--pt-chevron\)|var\(--lfs-tap, 44px\)) /, `first track fits the toggle: ${t}`)
    assert.match(t, / (var\(--pt-menu\)|max\(28px, var\(--lfs-tap-track, 0px\)\)|var\(--lfs-tap, 44px\))$/, `last track fits the menu: ${t}`)
  }
  assert.match(table, /--pt-chevron: max\(20px, var\(--lfs-tap-track, 0px\)\);/)
  assert.match(table, /--pt-menu: max\(40px, var\(--lfs-tap-track, 0px\)\);/)
  const machines = read('src/client/machines/machines.module.css')
  const fleet = [...machines.matchAll(/\.fleetTable \{\s*(?:display: grid;\s*)?grid-template-columns:\s*([^;]+);/g)].map((m) => m[1].replace(/\s+/g, ' ').trim())
  assert.ok(fleet.length >= 3, fleet.join('\n'))
  for (const t of fleet) assert.match(t, /^(max\(20px, var\(--lfs-tap-track, 0px\)\)|var\(--lfs-tap, 44px\)) /, `the fleet chevron track fits its 44px toggle: ${t}`)
})

// ---------------------------------------------------------------- 3. Files drawer

mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-review-css-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, elements, text } from 'react'",
      "export { FilesFrame, drawerFocusTarget } from './src/client/files/ProjectFiles.tsx'",
      "export { HeroProjectControl } from './src/client/hero/HeroProject.tsx'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'review.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'review.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

test('Files: the drawer is keyed on the Files container and stays inside it', () => {
  const css = read('src/client/files/Files.module.css')
  const drawer = blocks(css, '@container files-frame (max-width: 600px) {')
  assert.equal(drawer.length, 1, 'one container-keyed drawer block')
  assert.match(drawer[0], /\.side \{[^}]*position: absolute;[^}]*inset: 0;/)
  assert.doesNotMatch(drawer[0], /position: fixed/)
  for (const body of blocks(css, '@media (max-width: 834px) {')) assert.doesNotMatch(body, /\.side\b/, 'no viewport-keyed drawer')
  assert.match(css, /\.frame \{[^}]*position: relative;[^}]*overflow: hidden;/)
  assert.match(drawer[0], /\.treeShow\.treeShow \{\s*display: flex;/)
  // a desktop pane (the per-session panel, about 700px) keeps a narrower tree, not the drawer
  const narrow = blocks(css, '@container files-frame (max-width: 820px) {')
  assert.equal(narrow.length, 1)
  assert.match(narrow[0], /grid-template-columns: 200px minmax\(0, 1fr\);/)
  assert.doesNotMatch(narrow[0], /\.side\b/)
  assert.equal(blocks(css, '@container files-frame (max-width: 834px) {').length, 0, 'no drawer at desktop pane widths')
})

/** A fake element: focus() records itself; querySelector answers from `found`. */
const el = (name, found = {}) => ({
  name, offsetParent: {}, focused: 0,
  focus() { this.focused++ },
  querySelector(sel) { return found[sel] ?? null },
})

test('Files: focus moves into the drawer when it opens and back to the toggle when it closes', async () => {
  const api = { call: async () => ({ items: [], next: null, at: { id: 'c1' } }) }
  const t = (k) => k
  const view = M.mount(M.FilesFrame, { api, project: 'st/app', t, branches: [{ name: 'main', head: 'c1', parent: null, forkedFrom: null, state: 'open', commits: null }], more: undefined })
  let tree = await view.settle()
  const find = (pred) => M.elements(tree).find(pred)
  const aside = find((e) => e.type === 'aside')
  const toggle = find((e) => e.type === 'button' && e.props['aria-controls'] && e.props['aria-expanded'] !== undefined)
  assert.ok(aside?.props.ref && toggle?.props.ref, 'the drawer and its toggle carry refs')
  const row = el('row')
  const side = el('side', { '[data-active]': null, '[data-tree-key], [role="tree"] button': row })
  const button = el('toggle')
  aside.props.ref.current = side
  toggle.props.ref.current = button

  // nothing moves on the first render (a wide frame, the tree beside the file)
  assert.equal(row.focused + button.focused, 0)
  // with no file open the empty view offers the tree
  const show = find((e) => e.props?.actionClassName && e.props.action)
  assert.ok(show, 'the empty view has a Show files action')
  assert.equal(show.props.action.props.children, 'files_showTree')

  toggle.props.onClick()
  tree = view.render()
  assert.equal(find((e) => e.type === 'aside').props['data-open'], true)
  assert.equal(row.focused, 1, 'opening moves focus to the first row in the drawer')

  find((e) => e.type === 'aside').props.onKeyDown({ key: 'Escape', stopPropagation() {} })
  tree = view.render()
  assert.equal(find((e) => e.type === 'aside').props['data-open'], undefined)
  assert.equal(button.focused, 1, 'Esc returns focus to the toggle')

  // the Show files action opens it the same way
  show.props.action.props.onClick()
  tree = view.render()
  assert.equal(row.focused, 2)
  view.unmount()

  // the open file's row is preferred, then the find field
  const active = el('active')
  assert.equal(M.drawerFocusTarget(true, el('s', { '[data-active]': active }), null), active)
  const input = el('input')
  assert.equal(M.drawerFocusTarget(true, el('s', { input }), null), input)
  assert.equal(M.drawerFocusTarget(false, el('s'), button), button)
})

// ---------------------------------------------------------------- hero menu check through selectedId

test('hero: a project row\'s check is ours alone (DSH\'s Menu gets no selectedId for it)', async () => {
  const ownership = { state: 'project', project: 'st/app', projectId: 'pid', scratch: '/tmp/scratch' }
  const api = { op: async () => ({ rows: [] }), call: async () => ({ stores: [] }), onEvent: () => () => {}, pickDirectory: async () => null }
  const imports = { get: () => null, subscribe: () => () => {}, set: () => {} }
  const t = (k) => k
  const view = M.mount(M.HeroProjectControl, { sessionId: 'blank-1', api, t, tp: t, imports, ownership, retry: () => {} })
  const tree = await view.settle()
  const menu = M.elements(tree).find((e) => Array.isArray(e.props?.items) && 'selectedId' in e.props)
  assert.ok(menu, 'the project menu')
  assert.equal(menu.props.selectedId, undefined, 'no DSH trailing check on a project row')
  view.unmount()
  const none = M.mount(M.HeroProjectControl, { sessionId: 'blank-2', api, t, tp: t, imports, ownership: { state: 'notProject' }, retry: () => {} })
  const noneMenu = M.elements(await none.settle()).find((e) => Array.isArray(e.props?.items) && 'selectedId' in e.props)
  assert.ok(noneMenu.props.selectedId, 'No project keeps DSH\'s check')
  none.unmount()
})

// ---------------------------------------------------------------- 4. Logs cards

test('Logs: the card layout keeps the client as a label in its meta line', () => {
  const css = read('src/client/logs/logs.module.css')
  const card = blocks(css, '@container (max-width: 834px) {').find((b) => b.includes('grid-template-areas'))
  assert.ok(card, 'the card block')
  assert.match(card, /'time client outcome duration'/)
  const client = /\.table td:nth-child\(2\) \{([^}]*)\}/.exec(card)
  assert.ok(client, 'the Client cell has a card rule')
  assert.match(client[1], /grid-area: client;/)
  assert.match(client[1], /display: block;/)
  assert.doesNotMatch(client[1], /display: none/)
  assert.match(read('src/client/logs/LogsPage.tsx'), /<td role="cell" className=\{clsx\(css\.muted, css\.wClient\)\}>\{line\.client\}<\/td>/, 'the client stays the second cell')
})

// ---------------------------------------------------------------- 5. guide

test('guide: Buckets is Home\'s own tab in the CLI map and the bucket page', () => {
  for (const p of ['docs/guide/cli-map.md', 'docs/guide/bucket.md']) {
    assert.doesNotMatch(read(p), /Home › Stores › (SQLite › )?Buckets/, p)
  }
  for (const p of ['docs/guide/zh/cli-map.md', 'docs/guide/zh/bucket.md']) {
    assert.doesNotMatch(read(p), /主页 › Store › (SQLite › )?存储桶/, p)
  }
  assert.match(read('docs/guide/cli-map.md'), /Back up dialog, Home › Buckets \|/)
  assert.match(read('docs/guide/zh/cli-map.md'), /`主页 › 存储桶`/)
})
