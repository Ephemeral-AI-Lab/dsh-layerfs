// UI pass 3 on 3080, package U12a: click safety for power actions and fixes
// (F6), machine-named power controls (R FAIL 4), LayerFS's multi-command fix
// run step by step (R FAIL 1), an outdated record is not a worker that does
// not answer (R FAIL 2), the Files tab refusal as word + tip + fix (R FAIL 3),
// and a Doctor check that waits for its turn says so (F12).
//   node --test test/ui-pass-u12.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { freshState, treeAnswer } from './fixtures/doctor-scenarios.mjs'

const root = new URL('..', import.meta.url).pathname
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-ui-pass-u12-'))

// React, the DSH primitives and clsx are stubbed: the test reads the modules' pure exports, it renders nothing.
// Each importer gets a stub exporting exactly the names it imports from that package.
const stub = {
  name: 'stub-ui',
  setup(b) {
    b.onResolve({ filter: /^(react|react-dom|clsx|@deepseek-ai\/.*)(\/.*)?$/ }, (a) => ({ path: `${a.path}|${a.importer}`, namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
      const [spec, importer] = a.path.split('|')
      const text = readFileSync(importer, 'utf8')
      // the automatic JSX runtime's own names, imported by esbuild rather than the source
      const names = new Set(spec.endsWith('jsx-runtime') ? ['jsx', 'jsxs', 'Fragment'] : [])
      const quoted = spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      for (const m of text.matchAll(new RegExp(`import\\s+(type\\s+)?([^'";]*?)\\s+from\\s+['"]${quoted}['"]`, 'g'))) {
        if (m[1]) continue
        const braces = /\{([^}]*)\}/.exec(m[2])
        for (const part of braces ? braces[1].split(',') : []) {
          const w = part.trim()
          if (!w || w.startsWith('type ')) continue
          names.add(w.split(/\s+as\s+/)[0].trim())
        }
      }
      const lines = ['const f = function Stub() { return null }', 'export default f', ...[...names].map((n) => `export const ${n} = f`)]
      return { contents: lines.join('\n'), loader: 'js' }
    })
  },
}
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export * as doc from './src/shared/doctor.ts'",
      "export * as mm from './src/client/machines/model.ts'",
      "export * as dm from './src/client/doctor/model.ts'",
      "export { fixCall } from './src/client/storage/fix-call.ts'",
      "export { pressAllowed, guardedPress, PRESS_SETTLE_MS } from './src/client/ui/index.tsx'",
      "export { chainSteps } from './src/client/storage/StoragePage.tsx'",
      "export * as notices from './src/client/machines/notices.ts'",
      "export * as sm from './src/client/storage/model.ts'",
      "export * as metrics from './src/client/machines/metrics.ts'",
      "export { blockedOf } from './src/client/files/States.tsx'",
      "export { locales as machineLocales } from './src/client/machines/locale.ts'",
      "export { locales as storageLocales } from './src/client/storage/locale.ts'",
      "export { locales as doctorLocales } from './src/client/doctor/locale.ts'",
      "export { filesEn, filesZh } from './src/client/files/locale.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'u12.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [stub],
})
const M = await import(pathToFileURL(join(out, 'u12.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

const src = (path) => readFileSync(join(root, path), 'utf8')
const CHAIN = 'layerfs store remove sim-website-0cefe19cfdbb6fe8d224 && layerfs machine remove docker'
// the owner's docker record on 3080 (no vm_name): broken outdated, LayerFS's fix is the two-command chain
const docker = { name: 'docker', platform: 'docker', state: 'broken', reason: 'outdated', fix: CHAIN, message: 'docker has no vm_name; remove its record', stores: ['sim-website-0cefe19cfdbb6fe8d224'], sandboxes: [] }

// ---------------------------------------------------------------- R FAIL 1

test('R FAIL 1: a multi-command fix is a chain the page runs step by step; anything else in it keeps it a tip', () => {
  assert.deepEqual(M.doc.runnableFix(CHAIN), { kind: 'chain', steps: [{ kind: 'removeStore', store: 'sim-website-0cefe19cfdbb6fe8d224' }, { kind: 'removeMachine', machine: 'docker' }] })
  assert.equal(M.doc.removesMachine(M.doc.runnableFix(CHAIN)), 'docker')
  assert.equal(M.doc.removesSomething(M.doc.runnableFix(CHAIN)), true, 'a chain that removes asks the confirm press')
  // unchanged: stop && start is the restart; save-auth stays the login dialog; --force and unknown commands stay tips
  assert.deepEqual(M.doc.runnableFix('layerfs machine stop m && layerfs machine start m'), { kind: 'restart', machine: 'm' })
  assert.equal(M.doc.runnableFix('layerfs store save-auth <auth> --user <user> --password-stdin && layerfs store update s --auth <auth>').kind, 'saveAuth')
  assert.equal(M.doc.runnableFix('layerfs machine stop m --force && layerfs machine start m'), null)
  assert.equal(M.doc.runnableFix('layerfs store remove s && rm -rf /'), null)
  assert.equal(M.doc.runnableFix('layerfs store remove s && layerfs machine doctor m'), null, 'a step that opens something is not chained')
  assert.equal(M.doc.runnableFix(Array(5).fill('layerfs store remove s').join(' && ')), null, 'at most four steps')
  assert.equal(M.doc.removesSomething({ kind: 'chain', steps: [{ kind: 'start', machine: 'a' }, { kind: 'stop', machine: 'b' }] }), false)
})

test('R FAIL 1: docker\'s card and page offer the chain, never Run diagnostics; Remove… is its fix, with a reason when off', () => {
  assert.deepEqual(M.mm.fixAction(docker), { kind: 'chain', line: CHAIN })
  assert.equal(M.mm.runsFix(docker), true, 'Board.tsx and MachineDetail.tsx show Run diagnostics only when !runsFix')
  assert.equal(M.mm.fixRemoves(docker), true)
  // a chain about another machine stays a tip to copy
  assert.equal(M.mm.fixAction({ ...docker, fix: 'layerfs store remove s && layerfs machine remove other' }).kind, 'copy')
  const parts = src('src/client/machines/parts.tsx')
  assert.match(parts, /if \(fix\?\.kind === 'remove' \|\| fix\?\.kind === 'chain'\) \{/, 'PowerButton runs the chain through FixAction')
  assert.match(parts, /builtIn && !fixRemoves\(m\)/, 'a built-in whose fix removes it gets Remove…')
  assert.match(parts, /pending !== null \? t\('removeWaitPending'\)/, 'Remove… off while an action runs says why')
  assert.match(src('src/client/machines/Spec.tsx'), /const recordOnly = fixRemoves\(m\)/)
  // FixAction drives the steps itself: one attempt each, the step it is at, the first refusal ends it
  const ui = src('src/client/ui/index.tsx')
  const fa = ui.slice(ui.indexOf('export function FixAction'), ui.indexOf('/** The words a refusal needs'))
  assert.match(fa, /for \(let i = 0; i < steps\.length; i\+\+\) \{ setAt\(i\); await runner\.run\(steps\[i\]!\) \}/)
  assert.match(fa, /runner\.step\?\.\(at \+ 1, steps\.length, steps\[at\]!\)/)
  assert.match(fa, /const removes = removesSomething\(fix\)/)
  assert.match(fa, /if \(armedFor !== line\)/, 'an armed confirm never runs a different line')
  const center = src('src/client/storage/StoragePage.tsx')
  assert.match(center, /case 'chain': return t\('fixRunChain'/)
  assert.match(center, /fix\.kind === 'chain' \? t\('fixConfirmChain'/)
  for (const lang of ['en', 'zh']) {
    const L = M.storageLocales[lang]
    assert.ok(L.fixRunChain.includes('{n}') && L.fixConfirmChain.includes('{n}') && L.fixChainStep.includes('{step}'), lang)
    assert.ok(M.machineLocales[lang].removeWaitPending, lang)
  }
})

test('R FAIL 1: a chain\'s host calls run in order, one attempt each, and stop at the first refusal', async () => {
  const calls = []
  const api = { call: async (method, path) => { calls.push(`${method} ${path}`); if (path.includes('/machines/')) throw Object.assign(new Error('refused'), { code: 'InUse' }) } }
  await assert.rejects(M.fixCall(api, M.doc.runnableFix(CHAIN)), /refused/)
  assert.deepEqual(calls, ['DELETE /api/stores/sim-website-0cefe19cfdbb6fe8d224?confirm=sim-website-0cefe19cfdbb6fe8d224', 'DELETE /api/machines/docker'])
  calls.length = 0
  const failing = { call: async (method, path) => { calls.push(`${method} ${path}`); throw new Error('first refused') } }
  await assert.rejects(M.fixCall(failing, M.doc.runnableFix(CHAIN)), /first refused/)
  assert.equal(calls.length, 1, 'nothing after the refused step runs')
})

// ---------------------------------------------------------------- R FAIL 2

test('R FAIL 2: an outdated record whose fix removes it is not a worker that does not answer; no Stop for it', () => {
  assert.equal(M.mm.recordOutdated(docker), true)
  assert.equal(M.mm.workerDown(docker), false)
  assert.equal(M.mm.machineState(docker).label, 'stateRecordOutdated')
  // an outdated worker that a restart repairs is still down, worded as before
  const worker = { ...docker, name: 'b', fix: 'layerfs machine stop b && layerfs machine start b' }
  assert.equal(M.mm.workerDown(worker), true)
  assert.equal(M.mm.machineState(worker).label, 'stateOutdated')
  const home = src('src/client/storage/HomeOverview.tsx')
  const branch = home.slice(home.indexOf('} else if (recordOutdated(m)) {'), home.indexOf("} else if (look.key === 'needs') {"))
  assert.match(branch, /ovRecordOutdatedStores/)
  assert.doesNotMatch(branch, /secondary|kind: 'stop'/, 'the head never offers Stop for it')
  assert.match(src('src/client/machines/MachineDetail.tsx'), /recordOutdated\(m\) \? \(heldStores\(m\) === 1 \? 'storeBlockedRecordOne' : 'storesBlockedRecord'\)/)
  for (const lang of ['en', 'zh']) {
    assert.ok(M.storageLocales[lang].ovRecordOutdatedStores.includes('{stores}'), lang)
    assert.ok(M.machineLocales[lang].stateRecordOutdated && M.machineLocales[lang].storeBlockedRecordOne && M.machineLocales[lang].storesBlockedRecord.includes('{n}'), lang)
  }
  assert.doesNotMatch(M.machineLocales.en.storeBlockedRecordOne, /answers/)
})

// ---------------------------------------------------------------- R FAIL 3

test('R FAIL 3: the Files tab refusal is a word, LayerFS\'s words as the tip and its fix; never the code word or prose inline', () => {
  const states = src('src/client/files/States.tsx')
  const fallback = states.slice(states.indexOf('const code = errorCode(error)'), states.indexOf('export function blockedOf'))
  assert.doesNotMatch(fallback, /failureDetail|<code/, 'no inline sentence, no code chip')
  assert.match(fallback, /title=\{tip\}/, 'LayerFS\'s words, code and fix line are the tip')
  assert.match(states, /title = blockedWord\?\.\(blockedOf\(refusalOf\(error\)\.detail\)\) \?\? title/, 'a blocked refusal is worded by what blocks it, on both paths')
  // both LayerFS shapes: `Failed` with the machine's chain (runnable now), and the blocked refusal with reason + fix
  assert.deepEqual(M.blockedOf({ blocked_by: { machine: 'docker', reason: 'outdated' } }), { machine: 'docker', reason: 'outdated' })
  assert.deepEqual(M.blockedOf({ blockedBy: { machine: 'docker' } }), { machine: 'docker', reason: null })
  assert.equal(M.blockedOf(null), null)
  const files = src('src/client/files/ProjectFiles.tsx')
  assert.match(files, /removesMachine\(fix\) \? t\('files_blockedMachine'/)
  assert.match(files, /blockedWord=\{\(b\) => \(b\?\.machine \? t\('files_blockedMachine'/)
  for (const L of [M.filesEn, M.filesZh]) assert.ok(L.files_blockedMachine.includes('{machine}') && L.files_blocked && L.files_fix)
})

// ---------------------------------------------------------------- R FAIL 4

test('R FAIL 4: every Start, Restart and Stop names its machine in its accessible name', () => {
  const parts = src('src/client/machines/parts.tsx')
  const power = parts.slice(parts.indexOf('export function PowerButton'), parts.indexOf('/** Seconds since'))
  const buttons = power.match(/<Button [^]*?onClick=/g)
  assert.ok(buttons.length >= 3)
  for (const b of buttons) assert.match(b, /aria-label=\{named\(/, b.slice(0, 80))
  const menu = parts.slice(parts.indexOf('export function MachineMenu'), parts.indexOf('/** Whether a machine has settings'))
  assert.equal((menu.match(/t\('powerFor', \{ action: /g) ?? []).length, 3, 'Restart worker, Stop worker and Start/Stop name the machine')
  const row = src('src/client/doctor/Row.tsx')
  assert.match(row, /label=\{w\.t\('dpFixNamed', \{ fix: fixLabel, name: w\.nameOf\(x\) \}\)\}/, 'the Doctor row\'s Start names its thing')
  for (const lang of ['en', 'zh']) {
    assert.ok(M.machineLocales[lang].powerFor.includes('{action}') && M.machineLocales[lang].powerFor.includes('{name}'), lang)
    assert.ok(M.doctorLocales[lang].dpFixNamed.includes('{name}'), lang)
  }
})

// ---------------------------------------------------------------- F6

test('F6: a press only acts for the identity it was drawn for, after the control has settled', () => {
  const S = M.PRESS_SETTLE_MS
  assert.ok(S >= 400)
  assert.equal(M.pressAllowed({ identity: 'demo-build:start', at: 0 }, 'demo-build:start', S), true)
  assert.equal(M.pressAllowed({ identity: 'demo-build:start', at: 0 }, 'demo-build:start', S - 1), false, 'a button that just appeared under the pointer ignores the press')
  assert.equal(M.pressAllowed({ identity: 'docker:stop', at: 0 }, 'demo-build:start', 10 * S), false, 'a stale handler never acts on another row')
  // the guard is on every power and fix control
  for (const [file, pattern] of [
    ['src/client/machines/parts.tsx', /const guard = usePressGuard\(`\$\{m\.name\}:/],
    ['src/client/storage/HomeCards.tsx', /const guard = usePressGuard\(`restart:\$\{m\.name\}/],
    ['src/client/storage/HomeOverview.tsx', /const guard = usePressGuard\(`\$\{n\.key\}:/],
    ['src/client/ui/index.tsx', /const guard = usePressGuard\(line\)/],
    ['src/client/doctor/Row.tsx', /settle=\{`\$\{key\}:\$\{v\.fix\.line\}:\$\{o\.st\}/],
  ]) assert.match(src(file), pattern, file)
  // the head's Stop asks a second press that names the machine
  assert.match(src('src/client/storage/HomeOverview.tsx'), /confirm: t\('ovStopConfirm', \{ machine: place\(m\.name\) \}\)/)
  for (const lang of ['en', 'zh']) assert.ok(M.storageLocales[lang].ovStopConfirm.includes('{machine}'), lang)
  // dialogs keep their clicks: a portal's press never reaches the row or card that rendered it
  assert.match(src('src/client/storage/dialogs.tsx'), /props\.dialog \? <Contained><OpenDialog \{\.\.\.props\} \/><\/Contained> : null/)
  assert.match(src('src/client/doctor/DoctorPage.tsx'), /<Contained><Modal open/)
  assert.equal((src('src/client/machines/parts.tsx').match(/return <Contained><(Settings|ForceStop|Remove)Dialog/g) ?? []).length, 3)
})

/** The Doctor page's state over a fixture world (the stopped scenario: docker stopped, its Start offered from records). */
function doctorPage(scenario) {
  const world = freshState(scenario)
  const a = treeAnswer(world)
  return M.dm.setTree(M.dm.emptyState(), { at: 0, home: { home: a.home, state: a.state, version: a.version, generation: a.generation, reason: a.reason, fix: a.fix }, tree: a.tree })
}

test('F6: the Doctor runs a fix only while its row offers that very line, unchecked and free', () => {
  const state = doctorPage('stopped')
  const line = 'layerfs machine start docker'
  assert.equal(M.dm.fixOffered(state, 'machine:docker', line), true)
  assert.equal(M.dm.fixOffered(state, 'machine:docker', 'layerfs machine start demo-build'), false, 'another line')
  assert.equal(M.dm.fixOffered(state, 'machine:gone', line), false, 'a row no longer in the tree')
  // the row re-renders to Checking (its own check, or one that covers it): its Start is not run
  const checking = M.dm.addRuns(state, [{ id: 'r1', kind: 'machine', name: 'docker', full: false, group: null }], 0)
  assert.equal(M.dm.fixOffered(checking, 'machine:docker', line), false)
  const fixing = M.dm.fixStep(state, 'machine:docker', 'f1', 'start')
  assert.equal(M.dm.fixOffered(fixing, 'machine:docker', line), false)
  assert.match(src('src/client/doctor/use-doctor.ts'), /if \(!fixOffered\(ref\.current, thing\.key, row\.line\)\) return/)
})

// ---------------------------------------------------------------- F12

test('F12: a check the host has not started reads Waiting to start with Stop, never a silent Checking', () => {
  const state = M.dm.addRuns(doctorPage('healthy'), [{ id: 'r1', kind: 'store', name: 'qv2-store', full: false, group: null }], 1000)
  const key = 'store:qv2-store'
  assert.equal(M.dm.waitingRun(state, key, 1000 + M.dm.WAIT_SHOWN_MS - 1), undefined, 'a moment to start first')
  assert.equal(M.dm.waitingRun(state, key, 1000 + M.dm.WAIT_SHOWN_MS)?.id, 'r1')
  // its process started (a `running` event, with or without progress): no longer waiting
  const started = M.dm.onRun(state, { id: 'r1', kind: 'store', name: 'qv2-store', full: false, group: null, state: 'running', started: 1000, ended: null }, 2000)
  assert.equal(started.runs.r1.spawned, true)
  assert.equal(M.dm.waitingRun(started, key, 99_000), undefined)
  // a page that opens follows what the host holds, keeping whether it started
  const held = M.dm.seed(doctorPage('healthy'), { last: [], fixes: [], running: [{ id: 'r2', kind: 'store', name: 'qv2-store', full: false, group: null, state: 'queued', started: 0, ended: null }] }, 0)
  assert.equal(M.dm.waitingRun(held, key, 5000)?.id, 'r2')
  const heldRunning = M.dm.seed(doctorPage('healthy'), { last: [], fixes: [], running: [{ id: 'r3', kind: 'store', name: 'qv2-store', full: false, group: null, state: 'running', started: 0, ended: null }] }, 0)
  assert.equal(M.dm.waitingRun(heldRunning, key, 5000), undefined)
  const row = src('src/client/doctor/Row.tsx')
  assert.match(row, /const waiting = full \? undefined : waitingRun\(state, key, ctx\.now\)/)
  assert.match(row, /onPress=\{\(\) => on\.stop\(x\)\}>\{w\.t\('dpStop'\)\}/)
  assert.match(src('src/client/doctor/use-doctor.ts'), /\?\? Object\.values\(ref\.current\.runs\)\.find\(\(r\) => r\.target === thing\.key && !r\.spawned\)/, 'Stop ends a waiting call')
  assert.match(src('src/client/doctor/DoctorPage.tsx'), /r\.kind === 'full' \|\| !r\.spawned/, 'the clock ticks while a call waits')
  for (const lang of ['en', 'zh']) assert.ok(M.doctorLocales[lang].dpWaitingTurn && M.doctorLocales[lang].dpStopWaitLabel.includes('{name}'), lang)
})

test('F5: Store and connection controls and every fix button name what they act on (visible words stay short)', () => {
  const links = src('src/client/storage/StoreLinks.tsx')
  for (const key of ['pgChangeLogin', 'pgCheck']) assert.match(links, new RegExp(`aria-label=\\{t\\('ariaFor', \\{ action: t\\('${key}'\\), name: s\\.name \\}\\)\\}`), key)
  for (const key of ['pgCheck', 'edit', 'pgForget']) assert.match(links, new RegExp(`aria-label=\\{t\\('ariaForOn', \\{ action: t\\('${key}'\\), name: place\\(name\\), store: s\\.name \\}\\)\\}`), key)
  // the PostgreSQL Store card's Update (and every other fix button) goes through FixAction, whose name comes from the runner
  assert.match(src('src/client/ui/index.tsx'), /aria-label=\{runner\.named\?\.\(fix, words\) \?\? words\}/)
  assert.match(src('src/client/storage/StoreCard.tsx'), /<FixAction line=\{resolved\.line\} fix=\{resolved\.fix\} runner=\{fixes\}/)
  const center = src('src/client/storage/StoragePage.tsx')
  assert.match(center, /named: \(fix, words\) => \{/)
  assert.match(center, /return target && !words\.includes\(target\) \? t\('ariaFor', \{ action: words, name: target \}\) : words/)
  const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => vars[k])
  assert.equal(fill(M.storageLocales.en.ariaFor, { action: M.storageLocales.en.fixRunUpdateAuth, name: 'compact-demo-pg' }), 'Update (compact-demo-pg)')
  for (const lang of ['en', 'zh']) {
    assert.ok(M.storageLocales[lang].ariaFor.includes('{name}'), lang)
    assert.ok(M.storageLocales[lang].ariaForOn.includes('{name}') && M.storageLocales[lang].ariaForOn.includes('{store}'), lang)
  }
})

// ---------------------------------------------------------------- review fix loop

test('review FAIL-1: a chain that removes data asks the Store Remove\'s typed-name confirm, listing every step', () => {
  const chain = M.doc.runnableFix(CHAIN)
  assert.equal(M.doc.typedNameOf(chain), 'sim-website-0cefe19cfdbb6fe8d224', 'the Store step\'s name is typed, as the standalone Store Remove asks')
  assert.equal(M.doc.typedNameOf(M.doc.runnableFix('layerfs project delete s/p && layerfs machine remove m')), 's/p')
  // a chain with no data-removing step keeps the single confirm press
  const plain = M.doc.runnableFix('layerfs machine prune m --unused && layerfs machine remove m')
  assert.equal(plain.kind, 'chain')
  assert.equal(M.doc.typedNameOf(plain), null)
  assert.equal(M.doc.removesSomething(plain), true, 'still a second press')
  assert.equal(M.doc.typedNameOf(M.doc.runnableFix('layerfs store remove s')), null, 'a single Store remove keeps its own confirm')
  // every step listed, numbered, the data step saying so
  const L = M.storageLocales.en
  const t = (key, vars) => L[key].replace(/\{(\w+)\}/g, (_, k) => vars[k])
  const label = (f) => f.kind === 'removeMachine' ? t('fixRunRemoveRecord', { name: f.machine }) : f.kind
  assert.deepEqual(M.chainSteps(chain, label, t), ['1. Remove Store sim-website-0cefe19cfdbb6fe8d224 and its data', '2. Remove docker’s record'])
  const ui = src('src/client/ui/index.tsx')
  const fa = ui.slice(ui.indexOf('export function FixAction'), ui.indexOf('/** The words a refusal needs'))
  assert.match(fa, /if \(fix\.kind === 'chain' && typed\) \{\n\s+if \(!runner\.confirmChain \|\| !\(await runner\.confirmChain\(fix, typed\)\)\) return/, 'no typed confirm, no run')
  assert.match(fa, /\} else if \(removes && step === 'idle'\) \{ setStep\('confirm'\); return \}/)
  const center = src('src/client/storage/StoragePage.tsx')
  assert.match(center, /kind: 'confirm', title: t\('fixChainTitle', \{ n: fix\.steps\.length \}\), body: t\('fixChainBody'\), action: t\('fixChainAction'\), name: typed,/)
  assert.match(center, /steps: chainSteps\(fix, label, t\), cancelled: \(\) => resolve\(false\), run: async \(\) => \{ resolve\(true\) \}/)
  const dialogs = src('src/client/storage/dialogs.tsx')
  assert.match(dialogs, /\{steps\?\.length \? <ol data-steps=\{steps\.length\}>/)
  assert.match(dialogs, /onClose=\{\(\) => \{ dialog\.cancelled\?\.\(\); onClose\(\) \}\}/)
  assert.match(dialogs, /<TextField label=\{t\('typeToConfirm', \{ name \}\)\}/, 'the same typed-name field as Store Remove')
  for (const lang of ['en', 'zh']) for (const key of ['fixChainTitle', 'fixChainBody', 'fixChainAction', 'fixStepRemoveStore', 'fixStepDelete']) assert.ok(M.storageLocales[lang][key], `${lang} ${key}`)
})

test('review NOTE-1: the settle is visible (off and aria-disabled, one re-render at its end) and keyboard presses go through it', () => {
  const seen = { current: { identity: 'demo-build:start', at: 1000 } }
  let ran = 0
  let clock = 1000 + 100
  const press = M.guardedPress(seen, 'demo-build:start', M.PRESS_SETTLE_MS, () => { ran++ }, () => clock)
  const keyboardClick = () => { const e = { detail: 0, key: 'Enter', stopped: false, stopPropagation() { this.stopped = true } }; press(e); return e }
  assert.equal(keyboardClick().stopped, true, 'Enter inside the settle is dropped, as a pointer press is')
  assert.equal(ran, 0)
  clock = 1000 + M.PRESS_SETTLE_MS
  keyboardClick()
  assert.equal(ran, 1, 'after the settle Enter acts')
  seen.current = { identity: 'docker:stop', at: 0 }
  clock = 99_999
  keyboardClick()
  assert.equal(ran, 1, 'a handler drawn for another identity never acts, by keyboard either')
  const ui = src('src/client/ui/index.tsx')
  assert.match(ui, /const settling = settleMs > 0 && !pressAllowed\(seen\.current, identity, Date\.now\(\), settleMs\)/)
  assert.match(ui, /setTimeout\(\(\) => rerender\(\(n\) => n \+ 1\), Math\.max\(0, seen\.current\.at \+ settleMs - Date\.now\(\)\) \+ 5\)/, 'one timer re-render at at + settleMs')
  for (const [file, n] of [['src/client/machines/parts.tsx', 3], ['src/client/storage/HomeOverview.tsx', 2], ['src/client/storage/HomeCards.tsx', 1], ['src/client/ui/index.tsx', 1]]) {
    assert.equal((src(file).match(/aria-disabled=\{guard\.settling \|\| undefined\}/g) ?? []).length, n, file)
    assert.ok((src(file).match(/disabled=\{[^}]*guard\.settling\}/g) ?? []).length >= n, `${file} visibly off`)
  }
  assert.match(src('src/client/doctor/Row.tsx'), /aria-disabled=\{busy \|\| off \|\| guard\.settling \|\| undefined\}/, 'the Doctor button is drawn off by its aria-disabled style')
})

// ---------------------------------------------------------------- U12b

test('F7: the "close its Sandbox first" panel follows the Sandbox list and goes when they are gone', () => {
  const refusal = { code: 'InUse', message: 'Sandboxes run', detail: { sandboxes: ['sbm', 'sbm2'] } }
  assert.deepEqual(M.notices.inUseNow(refusal, ['sbm', 'sbm2', 'other']), { names: ['sbm', 'sbm2'], cleared: false })
  assert.deepEqual(M.notices.inUseNow(refusal, ['sbm2']), { names: ['sbm2'], cleared: false })
  assert.deepEqual(M.notices.inUseNow(refusal, []), { names: [], cleared: true })
  assert.equal(M.notices.inUseNow({ code: 'Busy', message: 'x' }, []), null)
  const detail = src('src/client/machines/MachineDetail.tsx')
  assert.match(detail, /const held = lastError !== null \? inUseNow\(lastError, sandboxesOn\(view, m\)\.map\(\(b\) => b\.name\)\) : null/)
  assert.match(detail, /const error = held\?\.cleared \? null : lastError/)
})

test('F11: a failed job\'s notice goes after a later success on its Store, or when the Store is gone', () => {
  const failed = { id: 'a', kind: 'compact', store: 's', ended: 10, error: { code: 'MountsActive' } }
  const stores = [{ name: 's' }]
  assert.equal(M.sm.failureSuperseded(failed, [failed], stores), false)
  assert.equal(M.sm.failureSuperseded(failed, [failed, { id: 'b', kind: 'compact', store: 's', ended: 20, error: null }], stores), true)
  assert.equal(M.sm.failureSuperseded(failed, [failed, { id: 'b', kind: 'compact', store: 's', ended: 5, error: null }], stores), false, 'an earlier success does not')
  assert.equal(M.sm.failureSuperseded(failed, [failed, { id: 'b', kind: 'backup', store: 's', ended: 20, error: null }], stores), false, 'another kind does not')
  assert.equal(M.sm.failureSuperseded(failed, [failed], []), true, 'its Store removed')
  assert.match(src('src/client/storage/HomeOverview.tsx'), /if \(failureSuperseded\(j, props\.jobs, view\.stores\)\) continue/)
})

test('F10: an in-use compaction is a word, its holders as the tip and Open <Sandbox>; never "failed in mark" or a raw refusal', () => {
  const t = (key, vars) => `${key} ${JSON.stringify(vars)}`
  const job = { id: 'j', kind: 'compact', store: 's', target: 's', started: 1, ended: 2, phase: 'mark', error: { code: 'MountsActive', message: 'mounts active: 2 holder(s)', phase: 'mark' } }
  assert.match(M.sm.endedWords(job, t), /^jobInUse /)
  assert.equal(M.sm.inUseJob(job), true)
  assert.match(M.sm.endedWords({ ...job, error: { code: 'Capacity', message: 'full', phase: 'mark' } }, t), /"phase":"stepMark[ "]/, 'a step in words, not its code')
  assert.deepEqual(M.sm.storeHolders('s', [{ name: 'sbn', project: 's/p' }, { name: 'x', project: 'other/p' }, { name: 'y', project: null }]).map((b) => b.name), ['sbn'])
  const home = src('src/client/storage/HomeOverview.tsx')
  assert.match(home, /t\('jobInUseHolders', \{ holders: holders\.map\(\(b\) => b\.name\)\.join\(', '\) \}\)/)
  assert.match(home, /holder \? \{ label: t\('jobOpenSandbox', \{ name: holder\.name \}\), run: \(\) => props\.onOpen\(`sandbox:\$\{holder\.machine \?\? 'native'\}\/\$\{holder\.name\}`\) \}/)
  const panel = src('src/client/storage/JobProgress.tsx')
  assert.doesNotMatch(panel, /<Refusal error=\{j\.error\}/, 'no raw refusal under the job')
  assert.match(panel, /title=\{j\.error \? \[`\$\{j\.error\.code\}: \$\{j\.error\.message\}`/)
  for (const lang of ['en', 'zh']) for (const key of ['jobInUse', 'jobInUseHolders', 'jobOpenSandbox']) assert.ok(M.storageLocales[lang][key], `${lang} ${key}`)
  assert.doesNotMatch(M.storageLocales.en.jobFailed, / in \{phase\}/)
})

test('F13: an image the free-space dialog could not remove reads Not removed; why and the message are the tip, no digest inline', () => {
  const images = src('src/client/machines/MachineImages.tsx')
  const refused = images.slice(images.indexOf('function Refused'), images.indexOf('export function ImagesTab'))
  assert.match(refused, /\{t\('pruneRefusedWord', \{ image: names\.get\(r\.id\) \?\? r\.id \}\)\}/)
  assert.doesNotMatch(refused, /t\('pruneRefused',/, 'the message is no longer the text')
  for (const lang of ['en', 'zh']) assert.ok(!M.machineLocales[lang].pruneRefusedWord.includes('{message}') && M.machineLocales[lang].pruneWhyInUse, lang)
})

test('F9: a record that cannot be read shows as such (no Running, no Stop) and the banners keep the path in their tip', () => {
  const err = { code: 'Failed', message: '/Users/x/.layerfs/machine/cs20ui-m/record.json: unexpected end at byte 14' }
  assert.equal(M.mm.unreadableNamed(err), 'cs20ui-m')
  assert.equal(M.mm.unreadableNamed({ code: 'Failed', message: 'no such thing' }), null)
  const view = { available: true, machines: [{ name: 'cs20ui-m', platform: 'lima', state: 'ready', reason: null, fix: null, stores: [], sandboxes: [] }, { name: 'b', platform: 'lima', state: 'ready', stores: [], sandboxes: [] }] }
  const stale = M.mm.staleView(view, err)
  const m = stale.machines[0]
  assert.equal(M.mm.unreadableRecord(m), true)
  assert.equal(M.mm.powerOf(m), null, 'no Start or Stop')
  assert.equal(M.mm.machineState(m).label, 'stateUnreadable')
  assert.equal(stale.machines[1], view.machines[1], 'the others as last read')
  assert.equal(M.mm.staleView(view, { code: 'Busy', message: 'later' }), view)
  const board = src('src/client/machines/Board.tsx')
  assert.doesNotMatch(board, /<Refusal error=\{read\.error\}/, 'no raw path or parse error inline')
  assert.match(board, /t\('staleUnreadable', \{ name: unreadableNamed\(read\.error\)! \}\)/)
  assert.match(board, /title=\{`\$\{e\.error\.code\}: \$\{e\.error\.message\}`\}>\{t\('partUnreadWord'/)
  assert.match(src('src/client/machines/controller.ts'), /data: staleView\(prev\.data, error\)/)
  assert.match(src('src/client/machines/Spec.tsx'), /live\?\.error && m\.state !== 'ready' && m\.state !== 'stopped' &&/, 'never "Down because: Running"')
})

test('F14: a stats read from before the machine\'s last start is not shown as its facts; a start reads again at once', () => {
  const read = { stats: { resources: {} }, at: 100, stale: null, reading: false, loaded: true }
  assert.equal(M.metrics.sinceStart(read, null), read)
  assert.equal(M.metrics.sinceStart(read, 50), read, 'read after the start')
  assert.deepEqual(M.metrics.sinceStart(read, 200), { stats: null, at: null, stale: null, reading: true, loaded: false })
  // the poller reads at once on refresh
  let reads = 0
  const clock = { now: () => 1000, setTimeout: () => 1, clearTimeout: () => {} }
  const poller = new M.metrics.MetricsPoller(async () => { reads++; return { at: 1000, machines: {}, sandboxes: {} } }, () => true, clock)
  poller.watch('m')
  return new Promise((resolve) => setTimeout(() => {
    const before = reads
    poller.refresh()
    setTimeout(() => {
      assert.ok(reads > before, 'refresh polled now')
      poller.dispose()
      assert.match(src('src/client/machines/controller.ts'), /status: 'success', endedAt: Date\.now\(\) \}\)\)\n\s+\/\/ a started machine's facts changed: read its stats now \(F14\)\n\s+this\.metrics\.refresh\(\)/)
      assert.match(src('src/client/machines/MachineStats.tsx'), /sinceStart\(statsReadOf\(snapshot, m\.name\), startedAt\)/)
      resolve()
    }, 10)
  }, 10))
})
