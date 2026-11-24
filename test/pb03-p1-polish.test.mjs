// Regression tests for PB-03 (P1-4 MachineDetail layout, P1-3 ProjectDialog Store conflict,
// P1-5 monospace font restoration, P1-1 e2e-crawl Doctor navigation).
// Fails on base 9db0c5e and passes after PB-03 changes.
//   node --test test/pb03-p1-polish.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as setupModel from '../src/client/projects/setup/model.ts'
import { locales as setupLocales } from '../src/client/projects/setup/locale.ts'

const PROJECT_NAME = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/

const root = fileURLToPath(new URL('..', import.meta.url))
const src = (rel) => readFileSync(join(root, rel), 'utf8')

test('P1-4: MachineDetail renders PageHead above TabBar uniformly for all machines and unifies factRow card styling', () => {
  const detail = src('src/client/machines/MachineDetail.tsx')
  assert.doesNotMatch(detail, /const docker = m\.platform === 'docker'/, 'must not bifurcate page layout on docker platform')
  assert.doesNotMatch(detail, /\{docker && machineHead\}/, 'PageHead must not be docker-only above TabBar')
  assert.doesNotMatch(detail, /\{!docker && <div className=\{logCss\.panelHead\}>\{machineHead\}<\/div>\}/, 'non-docker machines must not bury PageHead inside Overview')
  assert.doesNotMatch(detail, /m\.platform !== 'docker' && tab !== 'overview'/, 'persistent PageHead removes non-docker notice power fallback')
  assert.doesNotMatch(detail, /data-docker=/, 'factRow must not special-case docker')
  assert.match(detail, /<Page wide label=\{name\}>\s*\{machineHead\}\s*<TabBar /, 'PageHead sits directly above TabBar for every machine')

  const css = src('src/client/machines/machines.module.css')
  assert.doesNotMatch(css, /\.factRow\[data-docker\]/, 'factRow card styling must apply to all machines, not only [data-docker]')
  assert.match(css, /\.factRow\s*\{[^}]*display:\s*grid;[^}]*border:\s*0\.5px solid/s, 'shared .factRow uses the bordered card grid')
})

test('P1-3: resolveNewStoreName auto-renames on Store collision while keeping clean state untouched', () => {
  assert.equal(typeof setupModel.resolveNewStoreName, 'function', 'exports resolveNewStoreName helper')
  const view = { stores: [{ name: 'demo-store' }, { name: 'taken' }, { name: 'taken-2' }] }

  const clean = setupModel.resolveNewStoreName('my-app', null, view)
  assert.deepEqual(clean, {
    slugTaken: false,
    autoName: 'my-app',
    chosenName: 'my-app',
    showField: false,
    conflictNotice: false,
  })

  const clash = setupModel.resolveNewStoreName('demo-store', null, view)
  assert.deepEqual(clash, {
    slugTaken: true,
    autoName: 'demo-store-2',
    chosenName: 'demo-store-2',
    showField: true,
    conflictNotice: true,
  })

  const multiClash = setupModel.resolveNewStoreName('taken', null, view)
  assert.equal(multiClash.autoName, 'taken-3')
  assert.equal(multiClash.chosenName, 'taken-3')
  assert.equal(multiClash.conflictNotice, true)

  const edited = setupModel.resolveNewStoreName('demo-store', 'custom-store', view)
  assert.deepEqual(edited, {
    slugTaken: true,
    autoName: 'demo-store-2',
    chosenName: 'custom-store',
    showField: true,
    conflictNotice: false,
  })

  const emptySlug = setupModel.resolveNewStoreName('', null, view)
  assert.equal(emptySlug.showField, false)
  assert.equal(emptySlug.conflictNotice, false)
})

test('P1-3: ProjectDialog keeps Project Name valid on Store collision, shows editable Store name and prominent notice in EN/ZH', () => {
  const dialog = src('src/client/projects/setup/ProjectDialog.tsx')
  assert.doesNotMatch(dialog, /nameError\s*=[^\n]*storeTaken/, 'Project Name must not error when an existing Store shares the slug')
  assert.match(dialog, /resolveNewStoreName\(/, 'ProjectDialog delegates Store collision resolution to resolveNewStoreName')
  assert.match(dialog, /className=\{css\.storeConflictNotice\}[^>]*role="status"/, 'renders prominent status notice when auto-renaming a colliding Store')
  assert.match(dialog, /storeNameAutoHint/, 'uses localized auto-rename conflict copy')

  const css = src('src/client/projects/setup/dialog.module.css')
  assert.match(css, /\.storeConflictNotice\s*\{[^}]*--lf-tone-warning-bg[^}]*--lf-tone-warning-fg/s, 'conflict notice uses semantic warning callout tokens')

  for (const lang of ['en', 'zh']) {
    const dict = setupLocales[lang]
    assert.ok(dict.storeNameAutoHint, `${lang} defines storeNameAutoHint`)
    assert.match(dict.storeNameAutoHint, /\{taken\}/, `${lang} storeNameAutoHint names the occupied Store`)
    assert.match(dict.storeNameAutoHint, /\{store\}/, `${lang} storeNameAutoHint names the auto-assigned Store`)
    assert.ok(dict.storeNameHint, `${lang} defines storeNameHint`)
  }
})

test('P1-5: CLI commands, paths, SHAs, code lines and technical IDs restore DSH --ds-font-family-code token', () => {
  const trajectory = src('src/client/views/trajectory.module.css')
  assert.match(trajectory, /\.command\s*\{[^}]*font-family:\s*var\(--ds-font-family-code\)/s, 'trajectory .command uses --ds-font-family-code')

  const sandbox = src('src/client/views/sandbox.module.css')
  for (const cls of ['.project', '.mono', '.time', '.eventTime', '.eventMethod', '.detailCommand', '.detailOutput']) {
    const esc = cls.replace('.', '\\.')
    assert.match(sandbox, new RegExp(`${esc}\\s*\\{[^}]*font-family:\\s*var\\(--ds-font-family-code\\)`, 's'), `sandbox ${cls} uses --ds-font-family-code`)
  }

  const files = src('src/client/files/Files.module.css')
  for (const sel of ['\\.blameMeta code', '\\.blameNumber', '\\.blameText']) {
    assert.match(files, new RegExp(`${sel}\\s*\\{[^}]*font-family:\\s*var\\(--ds-font-family-code\\)`, 's'), `Files ${sel} uses --ds-font-family-code`)
  }

  const inspectFiles = src('src/client/machines/inspect-files.module.css')
  assert.match(inspectFiles, /\.code\s*\{[^}]*font-family:\s*var\(--ds-font-family-code\)/s, 'inspect-files .code uses --ds-font-family-code')

  const projectTable = src('src/client/storage/ProjectTable.module.css')
  assert.doesNotMatch(projectTable, /\.table\[data-store-column\]\s*:is\(\.branch,\s*\.mono,\s*\.sessionId\)\s*\{\s*font-family:\s*inherit/, 'ProjectTable must not strip monospace from .branch/.mono/.sessionId')

  const setupCss = src('src/client/setup/setup.module.css')
  assert.doesNotMatch(setupCss, /\.scroll\s*:is\(\.mono,\s*\.commit,\s*\.path\)\s*\{\s*font-family:\s*inherit/, 'setup.module.css must not strip monospace from .mono/.commit/.path')
  assert.doesNotMatch(setupCss, /--dsw-font-mono/, 'setup.module.css uses real DSH token --ds-font-family-code instead of undefined --dsw-font-mono')

  const homeOverview = src('src/client/storage/HomeOverview.module.css')
  assert.doesNotMatch(homeOverview, /^\.page\s*:is\(button,/m, 'HomeOverview must not override monospace buttons with higher specificity')
  assert.match(homeOverview, /:where\(\.page\)\s*:where\(button,\s*input,\s*select,\s*textarea,\s*summary\)\s*\{\s*font-family:\s*inherit;\s*\}/, 'HomeOverview uses zero-specificity :where() so monospace buttons keep --ds-font-family-code')

  const dialogCss = src('src/client/projects/setup/dialog.module.css')
  assert.match(dialogCss, /\.mono\s*\{[^}]*font-family:\s*var\(--ds-font-family-code\)/s, 'dialog.module.css .mono uses --ds-font-family-code')
})

test('P1-1: e2e-crawl navigates to Doctor/Logs/Settings through the NavBar instead of removed Health navigation', () => {
  const crawl = src('test/e2e-crawl.mjs')
  assert.doesNotMatch(crawl, /Health, Logs and Settings/, 'must not target removed Health, Logs and Settings navigation')
  assert.doesNotMatch(crawl, /centerPage\('Health'\)/, 'must not click renamed Health button')
  assert.match(crawl, /centerPage\('Doctor'\)/, 'opens Doctor via NavBar')
  assert.match(crawl, /getByRole\('region',\s*\{\s*name:\s*'Doctor'\s*\}\)/, 'waits for Doctor region landmark')
})

test('P1-3 (FIX1): freeStoreName and resolveNewStoreName handle 62/63-char names and multi-suffix collisions validly without hanging', () => {
  const name62 = 'a'.repeat(62)
  const res62 = setupModel.resolveNewStoreName(name62, null, { stores: [{ name: name62 }] })
  assert.equal(res62.slugTaken, true)
  assert.equal(res62.conflictNotice, true)
  assert.ok(res62.chosenName.length <= 63, `62-char candidate <= 63 chars: ${res62.chosenName}`)
  assert.match(res62.chosenName, PROJECT_NAME, `62-char candidate must satisfy NAME regex: ${res62.chosenName}`)
  assert.notEqual(res62.chosenName, name62)

  // Guard 63-char collision in a short-timeout subprocess so an infinite loop fails fast instead of hanging the test runner.
  const modelUrl = pathToFileURL(join(root, 'src/client/projects/setup/model.ts')).href
  const script = `
    import { freeStoreName, resolveNewStoreName } from ${JSON.stringify(modelUrl)};
    const name63 = 'a'.repeat(63);
    const r63 = resolveNewStoreName(name63, null, { stores: [{ name: name63 }] });
    const takenSingleDigit = [
      name63,
      ...Array.from({ length: 8 }, (_, i) => 'a'.repeat(61) + '-' + (i + 2)),
    ].map((name) => ({ name }));
    const multi10 = freeStoreName(name63, { stores: takenSingleDigit });
    const multi11 = freeStoreName(name63, { stores: [...takenSingleDigit, { name: 'a'.repeat(60) + '-10' }] });
    const sepBase = 'a'.repeat(60) + '-b';
    const sepRes = freeStoreName(sepBase, { stores: [{ name: sepBase }] });
    console.log(JSON.stringify({ r63, multi10, multi11, sepRes }));
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 3000 })
  const { r63, multi10, multi11, sepRes } = JSON.parse(out.trim())
  assert.equal(r63.slugTaken, true)
  assert.equal(r63.conflictNotice, true)
  assert.equal(r63.chosenName, `${'a'.repeat(61)}-2`)
  assert.match(r63.chosenName, PROJECT_NAME)
  assert.equal(multi10, `${'a'.repeat(60)}-10`)
  assert.match(multi10, PROJECT_NAME)
  assert.equal(multi11, `${'a'.repeat(60)}-11`)
  assert.match(multi11, PROJECT_NAME)
  assert.equal(sepRes, `${'a'.repeat(60)}-2`)
  assert.match(sepRes, PROJECT_NAME)
})

test('P1-4 (FIX1): MachineDetail keeps one PowerButton in PageHead and omits duplicate power actions in LogPane and InspectFiles', () => {
  const detail = src('src/client/machines/MachineDetail.tsx')
  assert.doesNotMatch(detail, /unavailableAction\s*=/, 'InspectFiles must not render a second power button when PageHead already stays on top')
  assert.doesNotMatch(detail, /unavailable=\{state\.state === 'stopped' \? \{[^}]*action:\s*power/, 'LogPane unavailable banner must not render a second power button')
  assert.match(detail, /unavailable=\{state\.state === 'stopped' \? \{ message: t\('logMachineStopped'\) \} : null\}/, 'LogPane keeps the stopped explanation banner without duplicating power')
})
