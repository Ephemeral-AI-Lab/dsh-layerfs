#!/usr/bin/env node
// End-to-end: LayerFS project sessions in the real DSH web UI with the
// scripted fake model (dev/fake-llm). Needs a dev server started with
// DSH_LAYERFS_DEV_OVERLAY=dev/fake-llm.overlay.yml.
//   node test/e2e-sessions.mjs [--keep]
// Checks: project workspace + session binding (branch, sandbox, mount, scratch),
// per-turn checkpoints, restore files to a checkpoint, branch session at a
// checkpoint (conversation fork + files fork), the LayerFS session store and
// persistence row, Scratch sessions (Scratch workspace and DSH's default
// workspace), the add-workspace project picker and the New Session project control.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDev, runTurn } from '../tools/e2e-lib.mjs'

const step = (m) => console.log(`\n== ${m}`)
const { browser, page, logs } = await openDev()
await page.waitForFunction(() => window.__dshLayerfs, null, { timeout: 30000 })
const op = (name, args = {}) => page.evaluate(async ([n, a]) => {
  try { return { ok: true, value: await window.__dshLayerfs.op(n, a) } } catch (e) { return { ok: false, code: e.code, message: e.message } }
}, [name, args])
const must = async (name, args) => { const r = await op(name, args); if (!r.ok) throw new Error(`${name}: ${r.code} ${r.message}`); return r.value }
const http = async (method, path, body) => {
  const r = await must('http', { method, path, ...(body === undefined ? {} : { body }) })
  if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (what, fn, ms = 30000) => {
  const end = Date.now() + ms
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(500) }
}

const tag = Date.now().toString(36)
const store = `e2e${tag}`, name = 'demo', project = `${store}/${name}`
let failed = false
try {
  step(`store + project ${project}`)
  const src = mkdtempSync(join(tmpdir(), 'dshlfs-e2e-'))
  writeFileSync(join(src, 'README.md'), '# demo\n')
  mkdirSync(join(src, 'src')); writeFileSync(join(src, 'src', 'main.js'), 'console.log(1)\n')
  await http('POST', '/api/stores', { name: store })
  const init = await http('POST', '/api/projects', { store, name, source: src })
  await until('project init', async () => (await http('GET', `/api/project-inits/${init.id}`)).step === 'done', 60000)

  step('new session in the project workspace')
  const prepared = await must('sessions.create', { project })
  assert.ok(prepared.workspaceId)
  await page.waitForTimeout(1500)
  const t1 = await runTurn(page, { workspace: name, message: 'bash: echo one > one.txt\nbash: echo note > "$HOME/scratch-note.txt" || true', newSession: false })
  assert.ok(t1.ok, `turn 1: ${t1.error}`)
  const sid = t1.sessionId
  assert.ok(sid, 'session id')
  let state = await until('bound + 1 checkpoint', async () => {
    const s = await must('session.state', { sessionId: sid })
    return s.binding?.state === 'bound' && s.checkpoints.some((c) => c.kind === 'turn') ? s : null
  })
  const b = state.binding
  console.log({ branch: b.branch, sandbox: b.sandbox, mount: b.mount, scratch: b.scratch })
  assert.equal(b.project, project)
  assert.ok(existsSync(join(b.mount, 'one.txt')), 'one.txt in the mount')
  assert.ok(existsSync(join(b.mount, 'README.md')), 'project files in the mount')
  assert.ok(existsSync(b.scratch), 'scratch folder')
  const cp1 = state.checkpoints.find((c) => c.kind === 'turn')
  assert.ok(cp1.commit, 'turn 1 committed')

  step('turn 2')
  const t2 = await runTurn(page, { message: 'bash: echo two > two.txt', newSession: false })
  assert.ok(t2.ok, `turn 2: ${t2.error}`)
  state = await until('2 checkpoints', async () => {
    const s = await must('session.state', { sessionId: sid })
    return s.checkpoints.filter((c) => c.kind === 'turn' && c.commit).length >= 2 ? s : null
  })
  assert.ok(existsSync(join(state.binding.mount, 'two.txt')))

  step('unchanged turn records no commit')
  const t3 = await runTurn(page, { message: 'bash: ls', newSession: false })
  assert.ok(t3.ok)
  await sleep(1000)
  state = await must('session.state', { sessionId: sid })
  assert.equal(state.checkpoints.filter((c) => c.kind === 'turn' && c.commit).length, 2, 'ls made no checkpoint')

  step('restore files to turn 1')
  const restored = await must('checkpoints.restore', { sessionId: sid, commit: cp1.commit })
  const mount = restored.binding.mount
  assert.ok(existsSync(join(mount, 'one.txt')), 'one.txt after restore')
  assert.ok(!existsSync(join(mount, 'two.txt')), 'two.txt gone after restore')
  console.log({ restoredBranch: restored.binding.branch, mount })

  step('branch the session at turn 1')
  await sleep(1500)
  state = await must('session.state', { sessionId: sid })
  const turn1 = state.checkpoints.find((c) => c.kind === 'turn' && c.turn === cp1.turn)
  assert.ok(turn1.endSeq !== undefined, 'turn 1 end seq recorded')
  const branched = await must('checkpoints.branch', { sessionId: sid, commit: turn1.commit, turn: turn1.turn })
  const child = branched.sessionId
  assert.ok(child && child !== sid)
  await page.waitForTimeout(2000)
  const t4 = await runTurn(page, { message: 'bash: ls > listing.txt', newSession: false })
  assert.ok(t4.ok, `child turn: ${t4.error}`)
  const cstate = await until('child bound', async () => {
    const s = await must('session.state', { sessionId: child })
    return s.binding?.state === 'bound' ? s : null
  })
  assert.equal(cstate.binding.from?.session, sid)
  assert.ok(existsSync(join(cstate.binding.mount, 'one.txt')), 'child has turn 1 files')
  assert.ok(!existsSync(join(cstate.binding.mount, 'two.txt')), 'child lacks turn 2 files')
  const listing = readFileSync(join(cstate.binding.mount, 'listing.txt'), 'utf8')
  assert.match(listing, /one\.txt/)

  step('LayerFS session store')
  await must('session.mirror', { sessionId: sid })
  const listed = await must('sessions.list', { project })
  console.log(listed.sessions.map((s) => ({ id: s.sessionId, stored: s.stored, cps: s.checkpoints, title: s.title })))
  const row = listed.sessions.find((s) => s.sessionId === sid)
  assert.ok(row?.stored, 'session stored in the project')
  const files = await http('GET', `/api/projects/${encodeURIComponent(project)}/fs?branch=${encodeURIComponent(`dsh.session.${sid.replace(/^session-/, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase()}`)}&path=${encodeURIComponent('/.dsh/session')}`)
  console.log(JSON.stringify(files).slice(0, 300))

  step('Scratch session (Scratch workspace): its own Workspace in the Scratch project')
  const scratchWs = await must('sessions.prepareScratch')
  assert.ok(scratchWs.workspaceId)
  await page.waitForTimeout(1500)
  const ts = await runTurn(page, { message: 'bash: echo s > s.txt', newSession: false })
  assert.ok(ts.ok, `scratch turn: ${ts.error}`)
  const runtime = await must('runtime.status')
  assert.equal(runtime.sessionPersistence, 'layerfs', 'the LayerFS session persistence row runs')
  const sstate = await until('scratch bound + checkpoint', async () => {
    const s = await must('session.state', { sessionId: ts.sessionId })
    return s.binding?.state === 'bound' && s.checkpoints.some((c) => c.kind === 'turn' && c.commit) ? s : null
  })
  assert.equal(sstate.scratchProject, true)
  assert.equal(sstate.binding.project, runtime.scratchProject)
  assert.ok(existsSync(join(sstate.binding.mount, 's.txt')), 's.txt in the Scratch Workspace')
  assert.ok(existsSync(sstate.binding.scratch), 'scratch folder')

  step('Default workspace session: also the Scratch project')
  const defaultRow = await page.locator('button[aria-label^="New session in "]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label').replace(/^New session in /, '')))
  const defaultTitle = defaultRow.find((title) => /default/i.test(title))
  assert.ok(defaultTitle, `default workspace row in ${JSON.stringify(defaultRow)}`)
  const td = await runTurn(page, { workspace: defaultTitle, message: 'bash: echo d > d.txt' })
  assert.ok(td.ok, `default workspace turn: ${td.error}`)
  const dstate = await until('default session bound', async () => {
    const s = await must('session.state', { sessionId: td.sessionId })
    return s.binding?.state === 'bound' && s.checkpoints.some((c) => c.kind === 'turn' && c.commit) ? s : null
  })
  assert.equal(dstate.binding.project, runtime.scratchProject)
  assert.ok(existsSync(join(dstate.binding.mount, 'd.txt')), 'd.txt in the Workspace, not the default folder')
  assert.ok(!existsSync(join(dstate.binding.mount, 's.txt')), 'each Scratch session has its own branch')

  step('Legacy: a session that already ran outside LayerFS is refused, not moved')
  await must('sessions.forget', { sessionId: td.sessionId })
  const tl = await runTurn(page, { message: 'bash: echo l > l.txt', newSession: false, expect: /before dsh-layerfs[^\n]*/ })
  assert.ok(tl.ok, `legacy refusal shown: ${tl.error}`)
  const lstate = await must('session.state', { sessionId: td.sessionId })
  assert.equal(lstate.binding, null)
  assert.equal(lstate.refusal?.code, 'LegacyFolderSession')

  step('UI: Add workspace picks a LayerFS project')
  await page.getByRole('button', { name: 'Add workspace' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Choose a LayerFS project' })
  await dialog.waitFor({ timeout: 15000 })
  await dialog.getByRole('button', { name: new RegExp(`^${name}\\s*${store}`) }).click()
  await dialog.waitFor({ state: 'detached', timeout: 20000 })
  await page.waitForTimeout(1000)
  const tp = await runTurn(page, { message: 'bash: echo picked > picked.txt', newSession: false })
  assert.ok(tp.ok, `picked project turn: ${tp.error}`)
  const pstate = await until('picked session bound', async () => {
    const s = await must('session.state', { sessionId: tp.sessionId })
    return s.binding?.state === 'bound' ? s : null
  })
  assert.equal(pstate.binding.project, project, 'the picked project')
  assert.ok(existsSync(join(pstate.binding.mount, 'picked.txt')))
  assert.ok(existsSync(join(pstate.binding.mount, 'README.md')), 'project files')

  step('UI: the New Session project control switches projects and creates one')
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const heroChip = page.locator('[data-layerfs-hero] button').first()
  await heroChip.waitFor({ timeout: 15000 })
  await until('hero shows the workspace project', async () => (await heroChip.innerText()).trim() === name)
  await heroChip.click()
  await page.getByRole('menuitem', { name: /Scratch \(no project\)/ }).click()
  await until('hero switched to Scratch', async () => (await page.locator('[data-layerfs-hero] button').first().innerText()).trim() === 'Scratch')
  await page.locator('[data-layerfs-hero] button').first().click()
  await page.getByRole('menuitem', { name: 'New empty project' }).click()
  await page.locator('[role=menu]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  const newDialog = page.getByRole('dialog', { name: 'New empty project' })
  await newDialog.waitFor({ timeout: 10000 })
  await page.waitForTimeout(1500)
  await newDialog.getByRole('button', { name: 'Store' }).click()
  await page.getByRole('menuitem', { name: store, exact: true }).click()
  await newDialog.getByLabel('Project name').fill('blank')
  await newDialog.getByRole('button', { name: 'Create and open' }).click()
  await until('hero on the new project', async () => (await page.locator('[data-layerfs-hero] button').first().innerText().catch(() => '')).trim() === 'blank', 60000)
  const tb = await runTurn(page, { message: 'bash: echo b > b.txt', newSession: false })
  assert.ok(tb.ok, `new project turn: ${tb.error}`)
  const bstate = await until('new project session bound', async () => {
    const s = await must('session.state', { sessionId: tb.sessionId })
    return s.binding?.state === 'bound' ? s : null
  })
  assert.equal(bstate.binding.project, `${store}/blank`)

  step('UI: the session panel shows the checkpoints')
  await page.locator(`[role=treeitem][data-row-key="session:${sid}"]`).first().click()
  await page.getByRole('button', { name: 'Open the LayerFS panel' }).first().click({ timeout: 15000 })
  await page.getByText('Checkpoints', { exact: true }).first().waitFor({ timeout: 15000 })
  await page.screenshot({ path: '/tmp/e2e-sessions-panel.png' })

  if (!process.argv.includes('--keep')) {
    step('cleanup')
    for (const id of [child, sid, ts.sessionId, td.sessionId, tp.sessionId, tb.sessionId]) await must('sessions.forget', { sessionId: id })
    await http('DELETE', `/api/projects/${encodeURIComponent(`${store}/blank`)}`)
    await http('DELETE', `/api/projects/${encodeURIComponent(project)}`)
    await http('DELETE', `/api/stores/${encodeURIComponent(store)}?confirm=${encodeURIComponent(store)}`).catch((e) => console.log('store kept:', e.message))
  }

  console.log('\nE2E PASS')
} catch (error) {
  failed = true
  console.error('\nE2E FAIL:', error?.stack ?? error)
  await page.screenshot({ path: '/tmp/e2e-sessions-fail.png' }).catch(() => {})
} finally {
  if (logs.length) console.log('console:', logs.slice(0, 20).join('\n'))
  await browser.close()
  process.exit(failed ? 1 : 0)
}
