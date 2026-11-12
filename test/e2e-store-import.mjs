#!/usr/bin/env node
// End-to-end: the LayerFS session store carries a session to another DSH.
// DSH "A" (DSH_LAYERFS_DEV_DIR=A) runs a turn in a project session; DSH "B"
// (a second dev server with its own DSH_HOME but the same LayerFS home) lists
// the session from the project, imports it, shows its conversation and
// continues it on the same branch. Then: a session opened in B by id alone is
// imported by the session persistence row, and a folder session (no project)
// is never stored, so B cannot see it.
//   A_DIR=<dev dir A> B_DIR=<dev dir B> node test/e2e-store-import.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { CHROME, runTurn } from '../tools/e2e-lib.mjs'
import { dismiss } from '../tools/ui.mjs'

const dirA = process.env.A_DIR, dirB = process.env.B_DIR
assert.ok(dirA && dirB, 'A_DIR and B_DIR')
const urlOf = (dir) => readFileSync(join(dir, 'url.txt'), 'utf8').trim()
const step = (m) => console.log(`\n== ${m}`)
const projectCommand = (command) => `bash: \"$DSH_LAYERFS_CLI\" workspace exec \"$DSH_LAYERFS_WS\" '${command.replaceAll("'", "'\\''")}' --stream`
const browser = await chromium.launch({ executablePath: CHROME, headless: true })

async function open(dir) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  await page.addInitScript(() => { localStorage.setItem('dsh-layerfs:debug', '1') })
  await page.goto(urlOf(dir), { waitUntil: 'networkidle' })
  await page.waitForFunction(() => window.__dshLayerfs, null, { timeout: 30000 })
  await page.waitForTimeout(800)
  await dismiss(page)
  const op = async (name, args = {}) => {
    const r = await page.evaluate(async ([n, a]) => {
      try { return { ok: true, value: await window.__dshLayerfs.op(n, a) } } catch (e) { return { ok: false, code: e.code, message: e.message } }
    }, [name, args])
    if (!r.ok) throw new Error(`${name}: ${r.code} ${r.message}`)
    return r.value
  }
  const http = async (method, path, body) => {
    const r = await op('http', { method, path, ...(body === undefined ? {} : { body }) })
    if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`)
    return r.body
  }
  // A session in the currently selected workspace, placed in the project.
  const openProject = (key) => page.evaluate(async (k) => window.__dshLayerfs.openProjectSession(k), key)
  return { page, op, http, openProject }
}

let failed = false
try {
  const A = await open(dirA)
  const tag = Date.now().toString(36)
  const store = `imp${tag}`, project = `${store}/app`
  step(`A: project ${project}, one turn`)
  const src = mkdtempSync(join(tmpdir(), 'dshlfs-imp-'))
  writeFileSync(join(src, 'README.md'), '# app\n')
  await A.http('POST', '/api/stores', { name: store })
  const init = await A.http('POST', '/api/projects', { store, name: 'app', source: src })
  for (let i = 0; i < 120 && (await A.http('GET', `/api/project-inits/${init.id}`)).step !== 'done'; i++) await new Promise((r) => setTimeout(r, 500))
  const placed1 = await A.openProject(project)
  await A.page.waitForTimeout(1500)
  const t1 = await runTurn(A.page, { message: projectCommand('echo from-a > a.txt'), newSession: false })
  assert.ok(t1.ok, t1.error)
  const observed = await A.op('session.annotations', { sessionId: placed1.sessionId })
  const invocations = observed.invocations ?? []
  const exec = invocations.find((row) => row.operation === 'workspace.exec' && row.origin === 'tool')
  assert.ok(exec?.toolCallId, 'managed CLI invocation has exact tool provenance')
  assert.deepEqual(exec.versions, [], 'workspace.exec receives no checkpoint links')
  assert.ok(Number.isFinite(exec.at) && Number.isFinite(exec.ms) && exec.tag === `dsh:${placed1.sessionId}:${exec.id}`, 'the receipt carries its time and tag')
  assert.deepEqual(exec.argv?.slice(0, 2), ['workspace', 'exec'], 'the receipt carries its redacted argv')
  assert.ok(!JSON.stringify(invocations).includes(src), 'no machine-local path in a receipt')
  assert.ok(invocations.some((row) => row.operation === 'workspace.commit' && row.origin === 'host' && row.versions.some((v) => v.effect === 'created')), 'turn save has its own host checkpoint receipt')
  // The placed blank keeps its id when the first turn materializes it; the
  // sidebar's selected-row scrape can lag behind navigation.
  const sid = placed1.sessionId
  await new Promise((r) => setTimeout(r, 2500))
  await A.op('session.mirror', { sessionId: sid })

  step('B: the project lists the stored session')
  const B = await open(dirB)
  const listed = await B.op('sessions.list', { project })
  const row = listed.sessions.find((s) => s.sessionId === sid)
  console.log(row)
  assert.ok(row?.stored, 'stored in the project')
  assert.equal(row.local, false, 'not yet local to B')

  step('B: import + open')
  const opened = await B.op('sessions.open', { sessionId: sid, project })
  assert.equal(opened.imported, true)
  const importedAnnotations = await B.op('session.annotations', { sessionId: sid })
  assert.ok(importedAnnotations.invocations?.some((row) => row.id === exec.id), 'portable sidecar preserves invocation identities')
  step('B: the Logs view shows the imported session from its receipts')
  const receiptLog = await B.op('logs.list', { tag: `dsh:${sid}:`, limit: 1000 })
  const execLine = receiptLog.lines.find((line) => line.tag === exec.tag)
  console.log({ lines: receiptLog.lines.length, sources: [...new Set(receiptLog.lines.map((line) => line.source ?? 'log'))] })
  assert.ok(receiptLog.lines.length > 0 && receiptLog.lines.every((line) => line.source === 'receipt'), 'B has no line of its own: every line comes from a receipt')
  assert.equal(execLine?.at, exec.at); assert.deepEqual(execLine.argv, exec.argv)
  assert.equal(execLine.dsh?.toolCallId, exec.toolCallId, 'receipt lines are labelled with their tool call')
  await B.page.waitForTimeout(2500)
  await B.page.getByText('done: 1 commands').first().waitFor({ timeout: 20000 })

  step('B: continue the project session')
  const t2 = await runTurn(B.page, { message: [projectCommand('cat a.txt > b.txt'), projectCommand('cat b.txt')].join('\n'), expect: /done: 2 commands/, newSession: false })
  if (!t2.ok) { await B.page.screenshot({path: join(dirB, 'e2e-import-failure.png')}); console.log(t2.transcript) }
  assert.ok(t2.ok, t2.error)
  const state = await B.op('session.state', { sessionId: sid })
  assert.equal(state.binding.state, 'bound')
  assert.ok(existsSync(join(state.binding.mount, 'a.txt')), 'A\'s file is in B\'s Workspace')
  assert.equal(readFileSync(join(state.binding.mount, 'b.txt'), 'utf8').trim(), 'from-a')
  await B.page.screenshot({ path: '/tmp/e2e-import-b.png' })

  step('A: a second session; B opens it by id alone (the persistence row finds and imports it)')
  const placed2 = await A.openProject(project)
  await A.page.waitForTimeout(1500)
  const tx = await runTurn(A.page, { message: projectCommand('echo x > x.txt'), newSession: false })
  assert.ok(tx.ok, tx.error)
  const xid = placed2.sessionId
  await new Promise((r) => setTimeout(r, 2500))
  await A.op('session.mirror', { sessionId: xid })
  const xopened = await B.op('sessions.open', { sessionId: xid })
  assert.equal(xopened.imported, true)
  await B.page.waitForTimeout(2500)
  await B.page.getByText('done: 1 commands').first().waitFor({ timeout: 30000 })
  const xrow = (await B.op('sessions.list', { project })).sessions.find((s) => s.sessionId === xid)
  assert.equal(xrow?.local, true, 'imported into B by opening it')

  step('A: a folder session (Scratch workspace); it is never stored, so B cannot see it')
  await A.op('sessions.prepareScratch')
  await A.page.waitForTimeout(1500)
  const ts = await runTurn(A.page, { message: 'bash: echo sx > sx.txt', newSession: false })
  assert.ok(ts.ok, ts.error)
  const sstate = await A.op('session.state', { sessionId: ts.sessionId })
  assert.equal(sstate.binding, null, 'a folder session binds to nothing')
  await new Promise((r) => setTimeout(r, 2500))
  await A.op('session.mirror', { sessionId: ts.sessionId })
  const missing = await B.op('sessions.open', { sessionId: ts.sessionId }).then(() => null, () => true)
  assert.ok(missing, 'B cannot open a session that was never stored in a project')

  step('cleanup')
  for (const id of [sid, xid, ts.sessionId]) {
    await B.op('sessions.forget', { sessionId: id })
    await A.op('sessions.forget', { sessionId: id })
  }
  await A.http('DELETE', `/api/projects/${encodeURIComponent(project)}`)
  await A.http('DELETE', `/api/stores/${encodeURIComponent(store)}?confirm=${encodeURIComponent(store)}`).catch((e) => console.log('store kept:', e.message))
  console.log('\nE2E PASS')
} catch (error) {
  failed = true
  console.error('\nE2E FAIL:', error?.stack ?? error)
} finally {
  await browser.close()
  process.exit(failed ? 1 : 0)
}
