// tools/ui.mjs `openPanel` against the DOM it drives, at 1280x820 and 390x844.
// The page is a static stand-in (no server): DSH's sidebar as its client
// renders it (a "Global panels" nav of panel-row buttons named by label; below
// 768 px a closed drawer, role=dialog, opened by `[data-sidebar-opener]`) and
// the LayerFS navigation bar of src/client/storage/Nav.tsx (Doctor, Logs and
// Settings icon buttons; at ≤ 480 px folded into "More", whose items are
// menuitems). The names come from the Storage locale, so a renamed label fails
// here. Needs system Chrome (as tools/shot.mjs); skipped without it.
//   node --test test/tools-ui-open-panel.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { locales } from '../src/client/storage/locale.ts'
import { openPanel } from '../tools/ui.mjs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const en = locales.en

/** The stand-in page; `drawer` and the More menu follow the viewport as in DSH and Nav.module.css. */
const fixture = () => `<!doctype html><html><head><style>
  body { margin: 0; font: 14px sans-serif; }
  .sidebar { width: 240px; }
  [data-drawer] .sidebar { position: absolute; inset: 0 auto 0 0; background: #fff; visibility: visible; }
  [data-drawer][data-collapsed] .sidebar { visibility: hidden; }
  .more { display: none; }
  @media (max-width: 480px) { .secondary { display: none; } .more { display: inline-flex; } }
</style></head><body>
<div id="frame"></div>
<script>
  const drawer = innerWidth < 768
  const frame = document.getElementById('frame')
  if (drawer) { frame.dataset.drawer = ''; frame.dataset.collapsed = '' }
  frame.innerHTML = \`
    \${drawer ? '<button data-sidebar-opener aria-label="Open sidebar">≡</button>' : ''}
    <div class="sidebar" \${drawer ? 'role="dialog" data-shortcut-modal="sidebar" aria-label="Navigation"' : ''}>
      <nav aria-label="Global panels">
        <button aria-label="Plugins"><span>Plugins</span></button>
        <button aria-label="LayerFS"><span class="panelTitle">LayerFS</span></button>
      </nav>
    </div>
    <main id="main"></main>\`
  const sidebar = frame.querySelector('.sidebar')
  const setOpen = (open) => {
    if (open) { delete frame.dataset.collapsed; sidebar.setAttribute('aria-modal', 'true') }
    else { frame.dataset.collapsed = ''; sidebar.removeAttribute('aria-modal') }
  }
  frame.querySelector('[data-sidebar-opener]')?.addEventListener('click', () => setOpen(true))
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer) setOpen(false) })
  const shown = (page) => { document.body.dataset.page = page }
  frame.querySelector('[aria-label="LayerFS"]').addEventListener('click', () => {
    shown('layerfs')
    document.getElementById('main').innerHTML = \`
      <header aria-label="${en.navLabel}">
        <nav aria-label="${en.crumbsLabel}"><ol><li><span aria-current="page">Home</span></li></ol></nav>
        <button class="secondary" aria-label="${en.navHealth}" data-go="health">🛡<span>2</span></button>
        <button class="secondary" aria-label="${en.navLogs}" data-go="logs">≣</button>
        <button class="secondary" aria-label="${en.navSettings}" data-go="settings">⚙</button>
        <button class="more" aria-label="${en.navMore}" aria-haspopup="menu">⋯</button>
      </header>\`
    for (const b of document.querySelectorAll('[data-go]')) b.addEventListener('click', () => shown(b.dataset.go))
    document.querySelector('.more').addEventListener('click', () => {
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      menu.innerHTML = \`
        <button role="menuitem" data-go="health">${en.navHealthFindings.replace('{n}', '2')}</button>
        <button role="menuitem" data-go="logs">${en.navLogs}</button>
        <button role="menuitem" data-go="settings">${en.navSettings}</button>\`
      for (const b of menu.querySelectorAll('[data-go]')) b.addEventListener('click', () => { shown(b.dataset.go); menu.remove() })
      document.body.append(menu)
    })
  })
</script></body></html>`

const chrome = existsSync(CHROME) ? (await import('playwright-core')).chromium : null
const browser = chrome ? await chrome.launch({ executablePath: CHROME, headless: true }) : null
test.after(() => browser?.close())

for (const [w, h] of [[1280, 820], [390, 844]]) {
  for (const [label, page] of [['LayerFS', 'layerfs'], ['Logs', 'logs'], ['Health', 'health'], ['Settings', 'settings']]) {
    test(`${w}x${h}: openPanel(page, '${label}')`, { skip: !browser && 'system Chrome not found' }, async () => {
      const tab = await browser.newPage({ viewport: { width: w, height: h } })
      try {
        tab.setDefaultTimeout(2000)
        await tab.setContent(fixture())
        await openPanel(tab, label)
        assert.equal(await tab.evaluate(() => document.body.dataset.page), page)
        // The phone drawer does not stay open over the page.
        assert.equal(await tab.locator('[data-shortcut-modal="sidebar"][aria-modal="true"]').count(), 0)
      } finally {
        await tab.close()
      }
    })
  }
}
