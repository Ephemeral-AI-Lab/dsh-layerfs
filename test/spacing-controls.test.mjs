// Spacing controls: coarse pointers get an 8 px gap and >=44 px hit targets,
// fine pointers keep the deliberate micro-spacing. These are the CSS rules the
// live spacing audit (scratch/spacing-audit.md) measured; assert the source so
// a later edit cannot quietly put the crowding back.
//   node --test test/spacing-controls.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = (p) => readFileSync(join(root, 'src/client', p), 'utf8')
const block = (css, selector) => {
  const i = css.indexOf(selector)
  assert.ok(i >= 0, `${selector} exists`)
  return css.slice(i, css.indexOf('}', i) + 1)
}
const coarse = '@media (pointer: coarse), (max-width: 834px)'

test('scale: one control gap, 4 px fine and 8 px coarse', () => {
  const css = src('ui/responsive.css')
  const base = css.slice(0, css.indexOf('@media'))
  assert.match(base, /--lfs-gap-control:\s*4px;/)
  assert.match(base, /--lfs-space-3:\s*12px;/)
  assert.match(base, /--lfs-space-4:\s*16px;/)
  assert.match(base, /--lfs-space-5:\s*24px;/)
  assert.match(base, /--lfs-space-6:\s*32px;/)
  const i = css.indexOf(coarse)
  assert.ok(i > 0, 'the coarse block exists')
  assert.match(css.slice(i), /--lfs-gap-control:\s*8px;/)
})

test('nav: Back/Forward and the crumb pair never touch; tools widen on coarse', () => {
  const css = src('storage/Nav.module.css')
  assert.match(block(css, '.history'), /gap:\s*var\(--lfs-gap-control, 4px\)/)
  assert.doesNotMatch(block(css, '@media (max-width: 480px)').slice(0, 4000), /\.history\s*\{\s*gap:\s*0/)
  assert.match(block(css, '.crumbPair'), /gap:\s*var\(--lfs-gap-control, 4px\)/)
  assert.match(block(css, '.crumbMore'), /margin-left:\s*0/)
  assert.doesNotMatch(css, /margin-left:\s*-4px/)
  const touch = css.slice(css.indexOf(coarse))
  assert.match(touch, /\.tools\s*\{\s*gap:\s*var\(--lfs-gap-control, 8px\)/)
})

test('tab strip: 4 px at fine is deliberate, 8 px at coarse only', () => {
  const css = src('ui/TabBar.module.css')
  const base = css.slice(0, css.indexOf(coarse))
  assert.match(block(base, '.tabs'), /gap:\s*4px/)
  const touch = css.slice(css.indexOf(coarse))
  assert.match(touch, /\.tabs\s*\{\s*gap:\s*var\(--lfs-gap-control, 8px\)/)
})

/** The bodies of every `@media <condition> { … }` block, and the stylesheet without them. */
const media = (css, condition) => {
  const bodies = []
  let rest = '', at = 0
  for (let i = css.indexOf(`@media ${condition} {`); i >= 0; i = css.indexOf(`@media ${condition} {`, at)) {
    rest += css.slice(at, i)
    let depth = 0, j = css.indexOf('{', i)
    const open = j
    for (; j < css.length; j++) { if (css[j] === '{') depth++; else if (css[j] === '}' && --depth === 0) break }
    bodies.push(css.slice(open + 1, j))
    at = j + 1
  }
  return { bodies, rest: rest + css.slice(at) }
}

test('small row controls: the 44 px hit target is a pseudo box, the visual stays small', () => {
  const css = src('storage/ProjectTable.module.css')
  assert.match(block(css, '.toggle {'), /position:\s*relative/)
  assert.match(block(css, '.store,\n.cellLink'), /position:\s*relative/)
  const { bodies, rest } = media(css, '(pointer: coarse), (max-width: 834px)')
  // A count's box applies at every pointer.
  const link = block(rest, '.cellLink::after')
  assert.match(link, /width:\s*max\(44px, 100%\)/)
  assert.match(link, /height:\s*max\(44px, 100%\)/)
  // The chevron's box is touch only: on a desktop its 20px column and 16px gap are
  // narrower than 44px, so the box would cover the project mark beside it.
  assert.doesNotMatch(rest, /\.toggle::after/, 'no chevron hit box outside the touch layout')
  const touch = bodies.join('\n')
  const hit = block(touch, '.toggle::after')
  assert.match(hit, /width:\s*max\(44px, 100%\)/)
  assert.match(hit, /height:\s*max\(44px, 100%\)/)
  // the coarse rule still grows the chevron itself
  assert.match(touch, /\.toggle\s*\{[^}]*width:\s*var\(--lfs-tap, 44px\)/)
})

test('machines rows: row-to-menu and fleet actions use the control gap', () => {
  const css = src('machines/machines.module.css')
  assert.match(block(css, '.lineMenu'), /margin-left:\s*var\(--lfs-gap-control, 4px\)/)
  assert.match(block(css, '.fleetActions'), /gap:\s*var\(--lfs-gap-control, 4px\)/)
})

test('home: one section rhythm and a phone hero inset', () => {
  const overview = src('storage/HomeOverview.module.css')
  assert.match(block(overview, '.section'), /gap:\s*var\(--lfs-section-gap\)/)
  const hero = src('storage/HomeHero.module.css')
  assert.match(block(hero, '@media (max-width: 480px)'), /padding:\s*14px var\(--lfs-space-4, 16px\)/)
  const touch = hero.slice(hero.indexOf(coarse))
  assert.match(touch, /\.tools,\s*\.actions\s*\{\s*gap:\s*var\(--lfs-gap-control, 8px\)/)
})

test('sidebars and call sheet: coarse switches are thumb targets; the call-sheet nav is 8 px', () => {
  const ws = src('projects/workspaces.module.css')
  assert.match(ws, /\.switch,\s*\n\.newMenu\s*\{[^}]*min-width:\s*44px/)
  assert.match(ws, /\.switchRail\s*\{[^}]*width:\s*44px/)
  assert.match(block(src('logs/logs.module.css'), '.detailNav'), /gap:\s*8px/)
})

test('text floor: our 11 px labels read at 12 px (DSH chrome excluded)', () => {
  // The audit's A2.text counts every text under 12 px in our views at coarse.
  const sandbox = src('views/sandbox.module.css')
  assert.doesNotMatch(sandbox, /font-size:\s*(?:10|10\.5|11|11\.5)px/, 'no text under 12 px in the sandbox map')
  const stats = src('storage/StorageVisuals.module.css')
  assert.doesNotMatch(stats, /font-size:\s*(?:10|10\.5|11|11\.5)px/, 'no text under 12 px in Stats')
})

test('home: the phone tab row keeps the control gap to its actions', () => {
  const css = src('storage/HomeHero.module.css')
  const phone = css.slice(css.indexOf('@media (max-width: 640px)'))
  // The tab's -0.5 px margin eats half a pixel of the row gap; coarse still gets 8.
  assert.match(block(phone, '.toolbar'), /row-gap:\s*calc\(var\(--lfs-gap-control, 8px\) \+ 0\.5px\)/)
})

test('history: the branch finder and Refresh are separate controls', () => {
  const css = src('files/History.module.css')
  assert.match(block(css, '.dock {'), /gap:\s*max\(6px, var\(--lfs-gap-control, 6px\)\)/)
  assert.match(block(css, '.dock .mapControls {'), /gap:\s*var\(--lfs-gap-control, 4px\)/)
})

test('machine images: the build hint sits above the scrolling list', () => {
  const tsx = src('machines/MachineImages.tsx')
  assert.ok(tsx.indexOf('<BuildHint />') < tsx.indexOf('css.imgList'), 'the hint comes before the list')
  assert.match(block(src('machines/machines.module.css'), '.imgHint {'), /margin-bottom:\s*10px/)
})
