#!/usr/bin/env node
// Observed values on the Machines and Sandbox pages (layerfs-project#164 "dsh-layerfs UI"):
//   O1  a machine's page shows what `machine stats` observed, per scope: the data disk (used of total, free)
//       with whose disk it is in plain words, processors and memory, the worker, each Store's size, and
//       how many daemons run of the Sandboxes recorded; the volume name is shown as LayerFS gave it
//   O2  the Machines board: every running machine's card has the observed disk; a stopped machine
//       shows its record with "Not observed (machine stopped)" and is never asked
//   O3  a value LayerFS did not observe reads "not observed" with its reason, never 0
//   O4  a Sandbox recorded running whose daemon is dead is not shown or counted as running; one that
//       could not be observed keeps its state, unconfirmed, with the reason
//   O5  the Sandbox page shows the daemon's pid and start time and its usage, or why there is none
//
// The rows compare the page with what the CLI answers on the same home.
//
//   DSH_LAYERFS_DEV_DIR=… DSH_LAYERFS_CLI=… [INSPECT_STANDIN_DIR=… | INSPECT_*_MACHINE / INSPECT_*_SANDBOX] \
//     node test/e2e-inspect-observe-machines.mjs
// Environment and what every row also checks: test/e2e-inspect-logs-lib.mjs, test/e2e-inspect-observe-lib.mjs.
import { NotRun, O, SCOPE_WORDS, cli, diskOf, editor, features, gibText, jump, main, needO, observed, openBoard, setupObserve, shot, sleep, spawnMark, spawnsSince, statsDriver, statsSpawns, waitObserved } from './e2e-inspect-observe-lib.mjs'

const RESOURCE_SCOPE = { host: 'of this computer', engine_host: 'of the system Docker runs on', vm: 'of this machine\'s VM' }
const REASON = { machine_stopped: 'the machine is stopped', host_process: 'a Sandbox on this computer is a plain process with no cgroup of its own', not_observed: 'the side that runs it did not answer', memory_not_read: 'memory was not read', deadline: 'the time limit came first', no_cgroup: 'the Sandbox\'s cgroup is not there', cgroup_v1: 'the machine has no cgroup v2', not_answered: 'the machine did not say', no_pid: 'its record names no process' }
/** A size as machines/model.ts `bytes` writes it. */
function bytesText(n) {
  if (n < 1000) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1000, i = 0
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++ }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}
const diskText = (r) => `${gibText(r.disk_used)} used of ${gibText(r.disk_total)}${r.disk_free != null ? ` · ${gibText(r.disk_free)} free` : ''}`

/** The Sandbox page's head chip, daemon line and usage line. */
const sandboxPage = (page) => page.evaluate(() => {
  const root = [...document.querySelectorAll('[data-storage-page]')].find((e) => e.offsetParent)
  if (!root) return null
  const proc = root.querySelector('[data-daemon-process]'), usage = root.querySelector('[data-sandbox-usage]')
  const head = root.querySelector('h1')?.parentElement
  return {
    head: head?.innerText ?? null, chipTitle: head?.querySelector('[data-tone]')?.getAttribute('title') ?? null, chipTone: head?.querySelector('[data-tone]')?.getAttribute('data-tone') ?? null, chipDashed: head?.querySelector('[data-tone]')?.hasAttribute('data-dashed') ?? false,
    process: proc?.getAttribute('data-daemon-process') ?? null, processText: proc?.textContent ?? null,
    usage: usage?.getAttribute('data-sandbox-usage') ?? null, usageReason: usage?.getAttribute('data-usage-reason') ?? null, usageText: usage?.innerText ?? null,
    cpu: usage?.querySelector('[data-usage-cpu]')?.textContent ?? null, memory: usage?.querySelector('[data-usage-memory]')?.textContent ?? null, pids: usage?.querySelector('[data-usage-pids]')?.textContent ?? null,
  }
})
async function waitSandbox(page, test, timeout = 20000) {
  const until = Date.now() + timeout
  let last = null
  for (;;) { last = await sandboxPage(page); if ((last && test(last)) || Date.now() > until) return last; await sleep(200) }
}

await main('e2e-inspect-observe-machines', async ({ run, page }) => {
  setupObserve()
  const has = await features(page)
  const needStats = () => { if (!has.inspect?.machineStats) throw new NotRun('the pinned CLI has no machine.stats (e2e-inspect-observe-absent.mjs checks that case)') }
  const needLive = () => { if (!has.sandboxLive) throw new NotRun('the pinned CLI\'s sandbox.list has no `live` option') }

  await run.row('O1', 'a machine\'s page shows what `machine stats` observed, per scope, with whose disk it is', async (t) => {
    needStats()
    const scopes = new Set()
    for (const m of [O.machine, O.docker, O.volume]) {
      if (!m.name) { t.note(`INSPECT_${m.env} is not set: that scope was not opened`); continue }
      const st = cli('machine', 'stats', '--', m.name), r = st.resources, d = st.data_disk
      await jump(page, m.title)
      const got = await waitObserved(page, (s) => diskOf(s)?.state === 'observed' && !!s.card.at, { timeout: 20000 })
      const s = got.state, disk = diskOf(s)
      if (!t.check(got.ok, `${m.name}: the page shows observed values (${JSON.stringify(disk)})`)) continue
      scopes.add(d.scope)
      t.check(disk.text.startsWith(diskText(r)), `${m.name}: the disk line is LayerFS's used, total and free ("${disk.text}" / ${diskText(r)})`)
      t.check(disk.scope === d.scope && disk.scopeWords === (SCOPE_WORDS[d.scope] ?? d.scope), `${m.name}: whose disk it is, in words (${d.scope}: "${disk.scopeWords}")`)
      t.check(s.resources.startsWith(`${r.cpus} cores · ${gibText(r.memory_used)} of ${gibText(r.memory_total)} memory used`) && s.resources.endsWith(RESOURCE_SCOPE[r.scope] ?? ''), `${m.name}: observed processors and memory, and whose (${r.scope}: "${s.resources}")`)
      t.check(s.card.cpus === String(r.cpus) && s.card.memory === `${gibText(r.memory_used)} of ${gibText(r.memory_total)} memory used` && s.card.disk === diskText(r), `${m.name}: the Details card has the same three (${s.card.cpus} · ${s.card.memory} · ${s.card.disk})`)
      t.check(s.card.diskScope === d.scope && s.card.diskSub.includes(SCOPE_WORDS[d.scope] ?? d.scope) && s.card.diskSub.includes(d.fs) && s.card.diskSub.includes(d.path), `${m.name}: the card names the scope, the filesystem and the path ("${s.card.diskSub}")`)
      if (d.volume) t.check(s.card.diskSub.endsWith(`volume ${d.volume}`), `${m.name}: the provider's volume name is shown as LayerFS gave it (${d.volume})`)
      if (st.worker) {
        t.check(s.worker?.startsWith(`LayerFS ${st.worker.version} · serving since `) && s.card.worker?.startsWith(`LayerFS ${st.worker.version} · serving since `) && s.card.worker.endsWith(`pid ${st.worker.pid}`), `${m.name}: the worker's version and start time ("${s.card.worker}")`)
        t.check(s.worker.includes(new Date(st.worker.started_at).toLocaleDateString('en-US')), `${m.name}: the start time is the worker's (${new Date(st.worker.started_at).toISOString()})`)
      } else t.check(s.worker === null && s.card.workerNone, `${m.name}: no worker, and the card says why ("${s.card.worker}")`)
      for (const store of st.stores ?? []) t.check((s.card.stores ?? '').includes(store.bytes == null ? `${store.name} (size not observed)` : `${store.name} ${bytesText(store.bytes)}`), `${m.name}: Store ${store.name}'s size (${store.bytes} bytes: "${s.card.stores}")`)
      t.check(s.card.live === `${st.sandboxes.live} of ${st.sandboxes.recorded} recorded Sandboxes`, `${m.name}: daemons running of Sandboxes recorded ("${s.card.live}")`)
      t.check(s.card.stale.length === 0 && s.card.notObserved.length === 0, `${m.name}: nothing is marked stale or not observed`)
      await shot(page, `observe-machine-${m.name}`)
    }
    t.note(`scopes checked: ${[...scopes].join(', ') || 'none'}${['host_fs', 'vm_disk', 'volume'].every((x) => scopes.has(x)) ? ' (all three)' : ''}`)
    t.check(scopes.size > 0, 'at least one machine was opened')
    const names = [O.docker, O.volume].filter((m) => m.name).map((m) => cli('machine', 'stats', '--', m.name).data_disk.volume).filter(Boolean)
    t.note(`provider names shown: ${names.join(', ') || 'none'} (the Machines page shows a provider's name only here, from machine.stats \`data_disk.volume\`, as it comes: a \`layerfs-\` name and an older \`lfs-\` name alike)`)
  })

  await run.row('O2', 'the board: observed disk on every running machine\'s card; a stopped machine shows its record, "Not observed (machine stopped)", and is never asked', async (t) => {
    needStats()
    needO(O.stopped)
    const mark = spawnMark()
    await openBoard(page)
    const running = [O.machine, O.docker, O.volume].filter((m) => m.name)
    const got = await waitObserved(page, (s) => running.every((m) => diskOf(s, m.name)?.state === 'observed'), { timeout: 30000 })
    const s = got.state
    for (const m of running) {
      const st = cli('machine', 'stats', '--', m.name), disk = diskOf(s, m.name)
      t.check(disk?.state === 'observed' && disk.text.startsWith(diskText(st.resources)) && disk.scopeWords === (SCOPE_WORDS[st.data_disk.scope] ?? st.data_disk.scope), `${m.name}: its card has the observed disk and whose it is ("${disk?.text}")`)
    }
    const off = diskOf(s, O.stopped.name)
    t.check(off?.state === 'not-observed' && off.text === 'Not observed (machine stopped)', `${O.stopped.name}: "Not observed (machine stopped)" ("${off?.text}")`)
    t.check(!/\b0 (GiB|MiB|B)\b/.test(off?.text ?? ''), `${O.stopped.name}: no zero stands in for a value`)
    await sleep(1500)
    const asked = statsSpawns(spawnsSince(mark))
    t.check(!(O.stopped.name in asked), `no \`machine stats ${O.stopped.name}\` was started (asked: ${Object.entries(asked).map(([k, v]) => `${k} ×${v.length}`).join(', ') || 'none'})`)
    await shot(page, 'observe-board')
    // its own page: the record's values stay, named as what it was created with
    const rec = cli('machine', 'get', '--', O.stopped.name)
    await jump(page, O.stopped.title)
    const page2 = (await waitObserved(page, (x) => diskOf(x)?.state === 'not-observed', { timeout: 15000 })).state
    t.check(page2.card.notObserved.includes('Not observed (machine stopped)') && page2.card.cpus === null && page2.card.disk === null, `${O.stopped.name}'s page: the observed facts read "Not observed (machine stopped)"`)
    if (rec.disk != null) t.check(page2.allText.includes('Created with') && page2.allText.includes(`${gibText(rec.disk)} disk`), `${O.stopped.name}'s page: the record's requested size stays, as "Created with … ${gibText(rec.disk)} disk"`)
    else t.note(`${O.stopped.name}'s record names no requested size`)
    await sleep(1200)
    t.check(!(O.stopped.name in statsSpawns(spawnsSince(mark))), `opening its page starts no \`machine stats\` either`)
    await shot(page, 'observe-machine-stopped')
  })

  await run.row('O3', 'a value LayerFS did not observe reads "not observed" with its reason, never 0', async (t) => {
    needStats()
    const m = needO(O.machine)
    const before = cli('machine', 'stats', '--', m.name)
    statsDriver.declare((c) => {
      const s = c.stats[m.name]
      c.stats[m.name] = { ...s, resources: { ...s.resources, memory_total: null, memory_used: null, reason: 'memory_not_read' }, stores: (s.stores ?? []).map((x) => ({ ...x, bytes: null, allocated: null })), sandboxes: { ...s.sandboxes, live: null }, complete: false, reason: 'deadline' }
    })
    try {
      await jump(page, m.title)
      const got = await waitObserved(page, (s) => s.card.notObserved.length > 0 && /not observed/i.test(s.resources ?? ''), { timeout: 25000 })
      const s = got.state
      if (!t.check(got.ok, `the page shows the values that were not observed (${JSON.stringify(s?.card.notObserved)})`)) return
      t.check(s.card.memory === null && s.card.notObserved.includes('Not observed (memory was not read)'), `memory: "Not observed (memory was not read)" (${JSON.stringify(s.card.notObserved)})`)
      t.check(s.resources.includes('memory not observed (memory was not read)') && !/\b0 (GiB|MiB|B)? ?of\b/.test(s.resources), `the one-line resources say so too, with no 0 ("${s.resources}")`)
      t.check(s.card.cpus === String(before.resources.cpus) && diskOf(s)?.state === 'observed', 'the values that were observed still show')
      for (const store of before.stores ?? []) t.check((s.card.stores ?? '').includes(`${store.name} (size not observed)`), `Store ${store.name}: "(size not observed)" ("${s.card.stores}")`)
      t.check(s.card.live === 'Not observed (the time limit came first)', `daemons running: not observed, with the reason ("${s.card.live}")`)
      t.check(s.allText.includes('Some values were not read: the time limit came first'), 'the card says the answer was not complete, and why')
      await shot(page, 'observe-machine-null')
    } finally {
      statsDriver.declare((c) => { const { machine: _m, observed_at: _o, ...rest } = before; c.stats[m.name] = rest })
    }
    const back = await waitObserved(page, (s) => s.card.notObserved.length === 0 && !!s.card.memory, { timeout: 25000 })
    t.check(back.ok, `once LayerFS observes them again the values are back ("${back.state?.card.memory}")`)
  })

  await run.row('O4', 'a Sandbox whose daemon is dead is not shown or counted as running; one not observed is unconfirmed, with the reason', async (t) => {
    needLive()
    const listed = cli('sandbox', 'list', '--page-size', '100', '--page-pos', '0', '--live').items ?? []
    const of = (b) => listed.find((x) => x.name === b.name)
    const dead = of(needO(O.dead))
    if (!dead || dead.live !== false) throw new NotRun(`sandbox.list --live does not say ${O.dead.name}'s daemon is dead (${JSON.stringify(dead?.live)})`)
    t.check(dead.state === 'running', `${dead.name} is recorded running, and LayerFS says its daemon is not (live false)`)
    // its machine's page
    const view = has.view
    const title = (name) => (name === 'native' ? 'LayerFS Home' : name === 'docker' ? 'Docker' : name)
    await jump(page, title(dead.machine))
    const got = await waitObserved(page, (s) => s.sandboxRows.some((r) => r.name === dead.name && r.live === 'false'), { timeout: 20000 })
    const row = got.state?.sandboxRows.find((r) => r.name === dead.name)
    t.check(row?.live === 'false' && row.text.includes('Daemon not running') && !/Running$/.test(row.text) && row.tone === 'danger', `its row reads "Daemon not running", not "Running" ("${row?.text}", tone ${row?.tone})`)
    const here = listed.filter((b) => b.machine === dead.machine)
    const runs = here.filter((b) => b.state === 'running' && b.live === true).length
    t.check(got.state.card.hereNow?.startsWith(`${runs} of ${here.length} running`), `the machine counts ${runs} of ${here.length} running: the dead one is not among them ("${got.state.card.hereNow}")`)
    t.check(/recorded as running ha(s|ve) no daemon/.test(got.state.card.hereDown ?? ''), `…and says how many have no daemon ("${got.state.card.hereDown}")`)
    await shot(page, 'observe-machine-dead-daemon')
    // the board
    await openBoard(page)
    const board = await waitObserved(page, (s) => s.sandboxRows.some((r) => r.name === dead.name), { timeout: 15000 })
    t.check(board.state.sandboxRows.find((r) => r.name === dead.name)?.text.includes('Daemon not running'), 'the board\'s row says the same')
    // its own page
    await jump(page, dead.name)
    const sb = await waitSandbox(page, (s) => /Daemon not running/.test(s.head ?? ''))
    t.check(/Daemon not running/.test(sb?.head ?? '') && !/\bRunning\b/.test((sb?.head ?? '').replace('Daemon not running', '')), `the Sandbox page's head reads "Daemon not running" ("${(sb?.head ?? '').replace(/\n/g, ' | ')}")`)
    await shot(page, 'observe-sandbox-dead')
    // a live one, for contrast
    const up = O.up.name ? of(O.up) : null
    if (up?.live === true) {
      await jump(page, title(up.machine))
      const g = await waitObserved(page, (s) => s.sandboxRows.some((r) => r.name === up.name), { timeout: 15000 })
      const r = g.state?.sandboxRows.find((x) => x.name === up.name)
      t.check(r?.live === 'true' && /Running$/.test(r.text), `${up.name}, whose daemon runs, reads "Running" ("${r?.text}")`)
    } else t.note('no Sandbox with a running daemon was named (INSPECT_SANDBOX): the contrast was not checked')
    // not observed
    const unseen = O.unseen.name ? of(O.unseen) : null
    if (unseen && unseen.live === null) {
      await jump(page, title(unseen.machine))
      const g = await waitObserved(page, (s) => s.sandboxRows.some((r) => r.name === unseen.name), { timeout: 15000 })
      const r = g.state?.sandboxRows.find((x) => x.name === unseen.name)
      const tip = await editor(page).locator(`[data-sandbox-row=${JSON.stringify(unseen.name)}]`).getAttribute('title')
      const why = REASON[unseen.live_reason] ?? String(unseen.live_reason ?? '').replaceAll('_', ' ')
      t.check(r?.live === 'null' && !r.text.includes('Daemon not running'), `${unseen.name} (live null) keeps its recorded state ("${r?.text}")`)
      t.check((tip ?? '').includes(`its daemon was not observed (${why})`), `…with the reason in its tooltip (${unseen.live_reason}: "${tip}")`)
      const dashed = await editor(page).locator(`[data-sandbox-row=${JSON.stringify(unseen.name)}] [data-dashed]`).count()
      t.check(dashed === 1, 'its chip is dashed: recorded, not confirmed')
      const mine = listed.filter((b) => b.machine === unseen.machine)
      t.check(g.state.card.hereNow?.startsWith(`${mine.filter((b) => b.state === 'running' && b.live === true).length} of ${mine.length} running`) && /recorded as running (was|were) not observed/.test(g.state.card.hereUnknown ?? ''), `it is not counted as running, and the count says it was not observed ("${g.state.card.hereNow}")`)
    } else t.note(`no Sandbox with live null was named (INSPECT_UNSEEN_SANDBOX${unseen ? `: ${unseen.name} is live ${unseen.live}` : ''}): that part was not checked`)
    void view
  })

  await run.row('O5', 'the Sandbox page shows the daemon\'s pid and start time and its usage, or why there is none', async (t) => {
    let seen = 0, withUsage = 0, withReason = 0
    for (const b of [O.up, O.dead, O.unseen]) {
      if (!b.name) continue
      const rec = cli('sandbox', 'get', '--', b.name)
      if (!('daemon' in rec) && !('usage' in rec)) { t.note(`${b.name}: this CLI's sandbox.get has no daemon or usage field`); continue }
      seen++
      await jump(page, b.name)
      const s = await waitSandbox(page, (x) => x.process !== null && x.usage !== null)
      if (!t.check(!!s?.process && !!s.usage, `${b.name}: the page has a daemon process part and a usage line (${JSON.stringify({ process: s?.process, usage: s?.usage })})`)) continue
      if (rec.daemon === null) t.check(s.process === 'not-observed' && s.processText.includes('process not observed'), `${b.name}: no daemon was observed, and the line says so ("${s.processText}")`)
      else if (rec.daemon.started_at == null) t.check(s.process === 'ended' && s.processText.includes(`pid ${rec.daemon.pid}`) && s.processText.includes('process ended'), `${b.name}: its recorded pid, and that the process has ended ("${s.processText}")`)
      else t.check(s.process === 'running' && s.processText.includes(`pid ${rec.daemon.pid}`) && s.processText.includes(`started ${new Date(rec.daemon.started_at).toLocaleString()}`), `${b.name}: the daemon's pid and when it started ("${s.processText}")`)
      if (rec.usage) {
        withUsage++
        const u = rec.usage
        t.check(s.usage === 'observed' && /^CPU time \S/.test(s.cpu) && !s.cpu.includes('Not observed'), `${b.name}: CPU time (${u.cpu_usec} µs: "${s.cpu}")`)
        t.check(s.memory.includes(`memory ${bytesText(u.memory_current)}`) && s.memory.includes(u.memory_peak == null ? 'peak Not observed' : `peak ${bytesText(u.memory_peak)}`), `${b.name}: memory now and at its peak ("${s.memory}")`)
        t.check(s.pids.includes(u.pids === 1 ? '1 process' : `${u.pids} processes`), `${b.name}: its process count ("${s.pids}")`)
      } else {
        withReason++
        const why = REASON[rec.usage_reason] ?? String(rec.usage_reason ?? '').replaceAll('_', ' ')
        t.check(s.usage === 'none' && s.usageReason === (rec.usage_reason ?? '') && s.usageText.includes(`not measured: ${why}`), `${b.name}: no usage, and why in plain words (${rec.usage_reason}: "${s.usageText.replace(/\n/g, ' ')}")`)
        t.check(!/\b0 (B|KB|MB)\b/.test(s.usageText) && !/CPU time 0/.test(s.usageText), `${b.name}: no zero stands in for it`)
      }
      await shot(page, `observe-sandbox-${b.name}`)
    }
    if (!seen) throw new NotRun('no named Sandbox\'s sandbox.get has the daemon or usage field')
    t.note(`Sandboxes with usage: ${withUsage}; with a reason instead: ${withReason}`)
  })
})
