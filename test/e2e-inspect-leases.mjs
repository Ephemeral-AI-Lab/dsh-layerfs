#!/usr/bin/env node
// The pages' reads and a Store's leases (layerfs-project#181 "dsh-layerfs UI"), on a REAL build:
//   K1  with a Sandbox page open and polling, the Store of that Sandbox gets no `open/<pid>` entry of a CLI process
//       and is never `in_use`; a push of another Store, sent as the Stores page sends it, succeeds meanwhile, and
//       the Sandbox page still shows its Workspaces
//
//   INSPECT_SANDBOX        a running Sandbox with Workspaces; its page is opened on the Daemon log tab
//   INSPECT_PUSH_STORE     a sqlite Store on `native` with no Sandbox, pushed to INSPECT_PUSH_MACHINE by this row
//                          (it stays there). Without it the push part is NOT_RUN.
//   INSPECT_HOOK           `leases machine <machine> <store>`: the names in <worker root>/store/<store>/open, one per
//                          line, then `worker <pid|->`
// A push of the Sandbox's own Store is `InUse` by design while that Sandbox is recorded (store.push "has running
// Sandboxes"); the row checks that this refusal names the Sandbox and no lease.
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs.
import { spawnSync } from 'node:child_process'
import { NotRun, cfg, editor, jump, lfs, main, probe, shot, sleep, spawnMark, spawns, spawnsSince, isInspect } from './e2e-inspect-files-lib.mjs'

const WINDOW_MS = Number(process.env.INSPECT_LEASE_WINDOW_MS || 75000)
const enc = encodeURIComponent
function leases(machine, store) {
  const r = spawnSync(cfg.hook, ['leases', 'machine', machine, store], { encoding: 'utf8', timeout: 20000 })
  if (r.status === 3) throw new NotRun(`INSPECT_HOOK cannot list leases here: ${(r.stdout || '').trim()}`)
  if (r.status !== 0) throw new Error(`INSPECT_HOOK leases machine ${machine} ${store} failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`)
  const lines = r.stdout.split('\n').filter(Boolean)
  const worker = (lines.find((l) => l.startsWith('worker ')) ?? 'worker -').slice(7)
  return { names: lines.filter((l) => !l.startsWith('worker ')), worker }
}

await main('e2e-inspect-leases', async ({ run, page }) => {
  await run.row('K1', 'a Sandbox page open and polling: no CLI lease on its Store, never in_use; another Store\'s push succeeds; the Workspaces stay', async (t) => {
    if (cfg.standin) throw new NotRun('a real build only: the stand-in keeps no leases')
    if (!cfg.hook) throw new NotRun('no INSPECT_HOOK: the Store\'s open/ folder cannot be listed')
    if (!cfg.sandbox) throw new NotRun('INSPECT_SANDBOX is not set')
    const rec = lfs('sandbox', 'get', cfg.sandbox)
    const store = rec.project.split('/')[0], machine = rec.machine
    const before = leases(machine, store)
    t.note(`Store ${store} on ${machine} before the page opens: open/ holds [${before.names.join(', ')}], worker pid ${before.worker}`)
    const mark = spawns() ? spawnMark() : null
    const t0 = Date.now()
    await jump(page, cfg.sandbox)
    await editor(page).getByRole('tab', { name: 'Daemon log', exact: true }).click()
    const seen = [], states = new Set()
    let lastHeld = null, foreign = []
    for (; Date.now() - t0 < WINDOW_MS;) {
      const now = leases(machine, store)
      const at = Date.now() - t0
      seen.push({ at, names: now.names })
      if (now.names.length) lastHeld = at
      for (const n of now.names) if (n !== now.worker) foreign.push(`${n} at ${at} ms`)
      if (seen.length % 5 === 1) { const s = await probe(page, 'GET', `/api/stores/${enc(store)}`).catch(() => null); const st = s?.body?.status?.state ?? s?.body?.state; if (st) states.add(st) }
      await sleep(machine === 'native' ? 150 : 1500)
    }
    const status = lfs('store', 'status', store)
    states.add(status.state)
    t.check(foreign.length === 0, `no entry in ${store}/open is a CLI process's: only the machine's own worker (pid ${before.worker}) ever holds one (${foreign.slice(0, 5).join('; ') || 'none other'})`)
    t.check(![...states].includes('in_use') && status.holders.length === 0, `the Store is never \`in_use\` and has no holder (states seen: ${[...states].join(', ')}; holders ${JSON.stringify(status.holders)})`)
    const held = seen.filter((s) => s.names.length).length
    t.note(`${seen.length} listings of ${store}/open in ${Math.round(WINDOW_MS / 1000)} s with the page polling: held in ${held}${held ? ` (by the worker, last at ${lastHeld} ms)` : ''}, empty in ${seen.length - held}`)
    if (mark !== null) {
      const made = spawnsSince(mark)
      const polls = made.inspect.length, storeReads = made.all.filter((s) => !isInspect(s.argv) && ['branch', 'project', 'file', 'commit'].includes(s.argv[0]) || (s.argv[0] === 'store' && s.argv[1] !== 'status' && s.argv[1] !== 'list'))
      const after = lastHeld === null ? made.inspect : made.inspect.filter((s) => s.at - t0 > lastHeld)
      t.note(`CLI processes of the page in that time: ${polls} monitoring reads (logs, files, stats), ${made.all.length - polls} others (${Object.entries(made.others).map(([k, n]) => `${k} ×${n}`).join(', ')}); reads of a Store's content among them: ${storeReads.map((s) => `${s.argv[0]} ${s.argv[1]} at ${s.at - t0} ms`).join(', ') || 'none'}`)
      if (held && seen.at(-1).names.length === 0) t.check(after.length > 0, `the worker's lease ended while the monitoring reads went on (${after.length} of them after it was last seen): they do not hold the Store open`)
      else if (held) t.check(false, `the worker's lease on ${store} was still there after ${Math.round(WINDOW_MS / 1000)} s with only this page open`)
      else t.check(polls > 0, `the page polled (${polls} monitoring reads) and the Store was never held`)
    }
    // the Sandbox's own Store: refused because of the Sandbox, not because of a lease
    let own = null
    try { lfs('store', ...(machine === 'native' ? ['push', store, process.env.INSPECT_PUSH_MACHINE || 'docker'] : ['pull', store])); own = { code: 'ok' } } catch (error) { try { own = JSON.parse(String(error.stderr ?? '').trim().split('\n').pop()) } catch { own = { code: '?', message: String(error.stderr ?? error.message).slice(0, 200) } } }
    const related = own.detail?.related ?? []
    t.check(own.code === 'InUse' && related.length > 0 && related.every((r) => r.kind === 'sandbox'), `moving the Sandbox's own Store (the CLI, with the page open) is refused \`InUse\` for its Sandbox, by design, and names no lease (${own.code}: ${String(own.message).slice(0, 140)}; related ${JSON.stringify(related)})`)
    // another Store, pushed as the Stores page pushes it
    const push = process.env.INSPECT_PUSH_STORE, to = process.env.INSPECT_PUSH_MACHINE || 'docker'
    if (push) {
      const was = lfs('store', 'status', push)
      if (was.machine !== 'native') t.note(`Store ${push} is already on ${was.machine}: the push was not sent`)
      else {
        const p0 = Date.now()
        const sent = await probe(page, 'POST', `/api/stores/${enc(push)}/push`, { machine: to })
        t.check(sent.ok, `POST /api/stores/${push}/push { machine: ${to} } (the Stores page's own request; it starts a job) is accepted with the Sandbox page open (${sent.status} ${sent.code ?? ''} ${String(sent.message ?? '').slice(0, 160)}; ${Date.now() - p0} ms)`)
        let now = null
        for (const until = Date.now() + 20000; Date.now() < until;) { now = lfs('store', 'status', push); if (now.machine === to && now.state !== 'in_use') break; await sleep(500) }
        t.check(now?.machine === to, `the push succeeded: Store ${push} is on ${to} ${Date.now() - p0} ms after the request (state ${now?.state})`)
        t.note(`Store ${push} was pushed to ${to} through the page's route in ${Date.now() - p0} ms while ${cfg.sandbox}'s page polled; the push dialog itself was not clicked`)
      }
    } else t.note('INSPECT_PUSH_STORE is not set: the push of another Store was NOT_RUN')
    // the Sandbox page still shows its Workspaces
    await editor(page).getByRole('tab', { name: 'Workspaces', exact: true }).click()
    const info = (await probe(page, 'GET', `/api/sandboxes/${enc(cfg.sandbox)}`)).body
    const panes = await editor(page).locator('input[data-term-input]').count()
    t.check(info.workspaces.length === rec.workspaces.length && panes > 0, `the Sandbox page still shows its Workspaces (${info.workspaces.length} of ${rec.workspaces.length}; ${panes} panes on this page of Terminals)`)
    await shot(page, 'inspect-leases-k1')
  })
})
