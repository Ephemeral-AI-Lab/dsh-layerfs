#!/usr/bin/env node
// Quarry v2 monitor (read only): call log + project-session logs of the run.
// node demo/quarry-v2/monitor/check.mjs --sid <root session id> --state <file> [--since-start]
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : (argv[i + 1] ?? true) }
const ROOT = arg('root', '/Users/yifanxu/Ephemeral-AI-Lab/deepseek-harness/state/layerfs')
const SID = arg('sid')
const STATE = arg('state')
const sinceStart = argv.includes('--since-start')
const state = STATE && existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}
const now = Date.now()
const runStart = Number(arg('start', state.runStart ?? now - 600_000))
const from = sinceStart ? runStart : (state.lastAt ?? now - 600_000)

// 1. sessions of the run: SID and its descendants
const sessions = new Map()
const projDir = join(ROOT, 'project-sessions', 'projects')
for (const p of readdirSync(projDir)) {
  const sd = join(projDir, p, 'sessions'); if (!existsSync(sd)) continue
  for (const cwd of readdirSync(sd)) for (const s of readdirSync(join(sd, cwd))) {
    const f = join(sd, cwd, s, 'session.v4.jsonl'); if (!existsSync(f)) continue
    const st = statSync(f); if (st.mtimeMs < runStart - 3600_000) continue
    const head = JSON.parse(readFileSync(f, 'utf8').split('\n', 1)[0])
    sessions.set(head.id, { id: head.id, parent: head.parentSession ?? null, file: f, mtime: st.mtimeMs, preset: head.agentPreset })
  }
}
const inRun = new Set([SID])
let grew = true
while (grew) { grew = false; for (const s of sessions.values()) if (s.parent && inRun.has(s.parent) && !inRun.has(s.id)) { inRun.add(s.id); grew = true } }

// 2. session status
const rows = []
let usage = { in: 0, cached: 0, out: 0 }
for (const id of inRun) {
  const s = sessions.get(id); if (!s) continue
  const lines = readFileSync(s.file, 'utf8').trim().split('\n')
  let last = 0, openTurn = false, turns = 0, label = '', skill = false, openTools = 0, errors = 0, lastText = ''
  const pending = new Set()
  for (const l of lines) {
    let r; try { r = JSON.parse(l) } catch { continue }
    if (r.time) last = r.time
    if (r.type === 'turn/start') { openTurn = true; turns++ }
    if (r.type === 'turn/end') openTurn = false
    if (r.type === 'session/title') label = r.data?.title ?? label
    if (r.type === 'tool/call') { pending.add(r.data.callId); if (r.data.name === 'skill' && /dsh-layerfs/.test(r.data.arguments)) skill = true }
    if (r.type === 'tool/result') pending.delete(r.data?.message?.toolCallId)
    if (r.type === 'step/end' && r.data?.error) errors++
    if (r.type === 'assistant/message') { const t = (r.data.message.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' '); if (t) lastText = t }
    if (r.type === 'usage' || r.type === 'step/usage' || r.data?.usage) {
      const u = r.data?.usage; if (u && r.time >= from) { usage.in += u.inputTokens ?? u.input ?? 0; usage.cached += u.cachedInputTokens ?? u.cacheRead ?? 0; usage.out += u.outputTokens ?? u.output ?? 0 }
    }
  }
  rows.push({ id: id.slice(8, 16), root: id === SID, label: label.slice(0, 40), turns, openTurn, idleMin: ((now - last) / 60000).toFixed(1), pendingTools: pending.size, skill, errors, lastText: lastText.replace(/\s+/g, ' ').slice(-160) })
}

// 3. call log lines of the run
const tagSessions = new Set([...inRun])
const sb = SID ? `dsh-${SID.replace(/^session-/, '').replace(/-/g, '').slice(0, 20)}` : null
const calls = []
// Call logs: the dsh-layerfs stand-in (before the 11:01Z runtime switch) and LayerFS's
// native log (after it; read only). Native `ms` is in-process time: label it "native ms".
const TRACES = [join(ROOT, 'trace'), arg('native-trace', join(process.env.HOME, '.layerfs', 'trace'))]
for (const p of TRACES.flatMap((d) => ['calls.1.jsonl', 'calls.jsonl'].map((f) => join(d, f)))) {
  if (!existsSync(p)) continue
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    if (!l) continue
    let x; try { x = JSON.parse(l) } catch { continue }
    if (x.at < from) continue
    const s = x.tag?.split(':')[1]
    const mine = tagSessions.has(s) || (s === '-' && (x.argv.includes('qv2-store/qv2-strata') || x.argv.some((a) => typeof a === 'string' && sb && a.startsWith(sb))))
    if (mine) calls.push({ ...x, session: s })
  }
}
const op = (x) => `${x.argv[0]}.${x.argv[1]}`
const by = new Map()
for (const x of calls) { const k = op(x); if (!by.has(k)) by.set(k, []); by.get(k).push(x) }
const pct = (a, q) => a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : 0
const fmt = (ms) => ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`
const table = [...by.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, xs]) => {
  const ms = xs.map((x) => x.ms).sort((a, b) => a - b)
  const ref = {}; for (const x of xs) if (x.outcome !== 'ok') ref[x.outcome] = (ref[x.outcome] ?? 0) + 1
  const kinds = {}; if (k === 'workspace.commit') for (const x of xs) kinds[x.kind ?? x.outcome] = (kinds[x.kind ?? x.outcome] ?? 0) + 1
  return { op: k, n: xs.length, p50: fmt(pct(ms, 0.5)), p90: fmt(pct(ms, 0.9)), max: fmt(ms.at(-1)), refused: Object.entries(ref).map(([c, n]) => `${c}×${n}`).join(' '), kinds: Object.entries(kinds).map(([c, n]) => `${c}×${n}`).join(' ') }
})
const refused = calls.filter((x) => x.outcome !== 'ok')
const writes = calls.filter((x) => ['write', 'edit', 'apply', 'rm', 'mkdir', 'mv', 'cp'].includes(x.argv[1]) && x.argv[0] === 'file' || ['commit'].includes(x.argv[1]) && x.argv[0] === 'workspace' || x.argv[0] === 'branch' && ['merge', 'fork', 'publish'].includes(x.argv[1]))
const committed = calls.filter((x) => x.outcome === 'ok' && ((x.argv[0] === 'file' && ['write', 'edit', 'apply', 'rm', 'mkdir', 'mv', 'cp'].includes(x.argv[1])) || (x.argv[0] === 'workspace' && x.argv[1] === 'commit' && x.kind === 'Committed') || (x.argv[0] === 'branch' && x.argv[1] === 'merge')))
// storms: same session|op|target
const storm = new Map(); for (const x of calls) { const k = `${x.session?.slice(8, 16)}|${op(x)}|${x.argv[2]}`; storm.set(k, (storm.get(k) ?? 0) + 1) }
const storms = [...storm.entries()].filter(([, n]) => n > 60)
// mount lifecycle: mounts per workspace name; execs on dsh's main
const mounts = calls.filter((x) => op(x) === 'workspace.mount').map((x) => { const i = x.argv.indexOf('--name'); return i > 0 ? x.argv[i + 1] : '?' })
const mountNames = {}; for (const m of mounts) mountNames[m] = (mountNames[m] ?? 0) + 1
const execMain = calls.filter((x) => op(x) === 'workspace.exec' && /:main$/.test(x.argv[2]) && x.session !== '-').length
const execMountPath = calls.filter((x) => op(x) === 'workspace.exec' && /\/layerfs\/data|\/run\/lfs-|\/workspaces\//.test(String(x.argv[3] ?? ''))).length
const slow = calls.filter((x) => op(x) !== 'workspace.exec' && x.ms > 10000).map((x) => `${op(x)} ${fmt(x.ms)} ${x.outcome}`)

const out = []
out.push(`window: ${new Date(from).toISOString().slice(11, 19)}Z → ${new Date(now).toISOString().slice(11, 19)}Z${sinceStart ? ' (since start)' : ''}`)
out.push(`sessions in run: ${rows.length} (live turns: ${rows.filter((r) => r.openTurn).length})`)
out.push('| sess | root | turns | open | idle min | pending tools | skill | step errs | label | last text |')
out.push('| --- | --- | ---: | --- | ---: | ---: | --- | ---: | --- | --- |')
for (const r of rows) out.push(`| ${r.id} | ${r.root ? 'R' : ''} | ${r.turns} | ${r.openTurn ? 'yes' : ''} | ${r.idleMin} | ${r.pendingTools} | ${r.skill ? 'y' : 'NO'} | ${r.errors} | ${r.label.replace(/\|/g, '/')} | ${r.lastText.replace(/\|/g, '/')} |`)
out.push(`calls: ${calls.length} (host '-': ${calls.filter((x) => x.session === '-').length}) · refused ${refused.length} (${calls.length ? (100 * refused.length / calls.length).toFixed(1) : 0}%) · writes ${writes.length} · landed commits ${committed.length}`)
out.push('| op | n | p50 | p90 | max | refused | kinds |  (ms after 11:01Z = native in-process time)')
out.push('| --- | ---: | ---: | ---: | ---: | --- | --- |')
for (const t of table) out.push(`| ${t.op} | ${t.n} | ${t.p50} | ${t.p90} | ${t.max} | ${t.refused} | ${t.kinds} |`)
out.push(`mounts by name: ${JSON.stringify(mountNames)} · exec on dsh main: ${execMain} · exec with mount path: ${execMountPath}`)
out.push(`storms: ${storms.length ? storms.map(([k, n]) => `${k}=${n}`).join(', ') : 'none'} · slow non-exec (>10 s): ${slow.length ? slow.join(', ') : 'none'}`)
const W1 = refused.filter((x) => /NotFound|Busy|busy/.test(JSON.stringify(x)) || x.outcome === 'Unknown')
out.push(`W1 (store contention refusals): ${W1.length} of ${writes.length} writes · refusals by code: ${JSON.stringify(refused.reduce((a, x) => (a[`${op(x)}:${x.outcome}`] = (a[`${op(x)}:${x.outcome}`] ?? 0) + 1, a), {}))}`)
out.push(`tokens (window): in ${usage.in} cached ${usage.cached} out ${usage.out}`)
console.log(out.join('\n'))
if (STATE && !sinceStart) writeFileSync(STATE, JSON.stringify({ ...state, runStart, lastAt: now }))
