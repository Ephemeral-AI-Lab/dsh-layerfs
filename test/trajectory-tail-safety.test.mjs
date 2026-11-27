// B9-C tail reader safety: the receipts boundary search past turnless and long
// rows, a window read while the log grows, the bounded prompt anchor, and an
// unparsable line in a backward scan.
//   node --test test/trajectory-tail-safety.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import fs, { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readReceiptsWindow, readTrajectoryWindow, tailFile, tailPageReader } from '../src/host/sessions/trajectory-tail.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const dir = mkdtempSync(join(root, 'lib', '.test-trajectory-tail-safety-'))
test.after(() => rmSync(dir, { recursive: true, force: true }))

const SID = 'session-tail-safety'
const LIMITS = { minBytes: 1, startBytes: 128 * 1024 }
let fixture = 0
const fresh = (name) => join(dir, `${++fixture}-${name}`)

const ev = (seq, type, data) => ({ seq, type, data, time: 1000 + seq })
const txt = (text) => ({ type: 'text', text })

/** A v4 log of `turns` turns, four records each, with system messages and request headers on the turns named. */
function makeLog({ turns = 400, systemsAt = [], headersAt = [] } = {}) {
  const events = []
  let seq = 0
  for (let turn = 1; turn <= turns; turn++) {
    events.push(ev(++seq, 'turn/start', { turn }))
    if (systemsAt.includes(turn)) events.push(ev(++seq, 'system/message', { turn, step: 1, message: { content: [txt(`system prompt ${turn}`)], source: { kind: 'system-prompt' } } }))
    if (headersAt.includes(turn)) events.push(ev(++seq, 'request/header', { header: { config: { provider: 'deepseek', model: 'deepseek-chat' }, tools: [{ name: 'bash', description: `run ${turn}` }] } }))
    events.push(ev(++seq, 'step/start', { turn, step: 1 }))
    events.push(ev(++seq, 'user/message', { source: { kind: 'user' }, content: [txt(`ask ${turn} ${'x'.repeat(60)}`)] }))
    events.push(ev(++seq, 'assistant/message', { turn, step: 1, message: { content: [txt(`answer ${turn} ${'x'.repeat(60)}`)] } }))
    for (let c = 0; c < 2; c++) {
      const callId = `call_${turn}_${c}`
      events.push(ev(++seq, 'tool/call', { turn, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command: `read ${turn} ${c}` }) }))
      events.push(ev(++seq, 'tool/result', { turn, step: 1, message: { toolCallId: callId, content: [txt(`ok ${turn} ${c}`)] } }))
    }
    events.push(ev(++seq, 'step/end', { turn, step: 1 }))
    events.push(ev(++seq, 'turn/end', { turn }))
  }
  const path = fresh('session.v4.jsonl')
  const lines = [JSON.stringify({ type: 'session', version: 4, id: SID }), ...events.map((event) => JSON.stringify(event))]
  writeFileSync(path, `${lines.join('\n')}\n`)
  return { path, events, lines }
}

/** The byte offset of line `index` (0 is the header) in `lines`. */
const lineOffset = (lines, index) => lines.slice(0, index).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)

const receipt = (turn, c, extra = {}) => ({
  id: `r_${turn}_${c}`, origin: 'tool', sessionId: SID, project: 'st/p', turn, toolCallId: `call_${turn}_${c}`,
  operation: 'file.read', outcome: 'success', versions: [], argv: ['file', 'read', 'st/p', 'dsh.s', `/f-${turn}-${c}`], ...extra,
})
/** A host operation recorded with no turn (a bind, a view poll, a refusal). */
const hostOp = (i) => ({ id: `h_${i}`, origin: 'host', sessionId: SID, operation: 'workspace.bind', outcome: 'success', versions: [], argv: ['workspace', 'bind', 'x'.repeat(120)] })

function writeReceipts(rows) {
  const path = fresh('receipts.jsonl')
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
  return path
}

/** Run `fn` with `fs.readSync` wrapped (the module's named import follows the builtin export). */
function withReadSync(wrap, fn) {
  const original = fs.readSync
  fs.readSync = wrap(original)
  syncBuiltinESMExports()
  try {
    return fn()
  } finally {
    fs.readSync = original
    syncBuiltinESMExports()
  }
}

test('receipts: a turnless run past the boundary does not skip the window\'s first receipts', () => {
  // Turn 200's first receipt, then ~400 KB of host ops with no turn, then the
  // rest of turn 200 on: the first probe lands in the turnless run, after the
  // boundary.
  const rows = []
  for (let turn = 1; turn < 200; turn++) rows.push(receipt(turn, 0), receipt(turn, 1))
  rows.push(receipt(200, 0))
  for (let i = 0; i < 2000; i++) rows.push(hostOp(i))
  rows.push(receipt(200, 1))
  for (let turn = 201; turn <= 260; turn++) rows.push(receipt(turn, 0), receipt(turn, 1))
  const path = writeReceipts(rows)
  const read = readReceiptsWindow(path, 200)
  assert.ok(read, 'the window is readable')
  assert.deepEqual(read.receipts.map((row) => row.id), rows.filter((row) => Number.isInteger(row.turn) && row.turn >= 200).map((row) => row.id))
  assert.ok(read.bytes < statSync(path).size, 'still a tail read')
})

test('receipts: a receipt line over 64 KB at the probe does not skip the window\'s first receipts', () => {
  const rows = []
  for (let turn = 1; turn < 200; turn++) rows.push(receipt(turn, 0), receipt(turn, 1))
  rows.push(receipt(200, 0, { argv: ['file', 'write', 'y'.repeat(300 * 1024)] }))
  rows.push(receipt(200, 1))
  for (let turn = 201; turn <= 260; turn++) rows.push(receipt(turn, 0), receipt(turn, 1))
  const path = writeReceipts(rows)
  const read = readReceiptsWindow(path, 200)
  assert.ok(read, 'the window is readable')
  assert.deepEqual(read.receipts.map((row) => row.id), rows.filter((row) => row.turn >= 200).map((row) => row.id))
})

test('receipts: a turnless run longer than the probe scan falls back instead of guessing', () => {
  const rows = []
  for (let turn = 1; turn < 200; turn++) rows.push(receipt(turn, 0), receipt(turn, 1))
  rows.push(receipt(200, 0))
  for (let i = 0; i < 16000; i++) rows.push(hostOp(i))
  rows.push(receipt(200, 1))
  const path = writeReceipts(rows)
  assert.equal(readReceiptsWindow(path, 200), undefined, 'the boundary cannot be found within the bound: whole parse')
})

test('a log that grows during the anchored read is not cached under the grown identity', () => {
  // The page's system message at turn 400 anchors to the one at turn 250; an
  // append lands while that span is read.
  const log = makeLog({ systemsAt: [250, 400], headersAt: [400] })
  const anchorIndex = log.events.findIndex((event) => event.type === 'turn/start' && event.data.turn === 250) + 1
  const anchorOffset = lineOffset(log.lines, anchorIndex)
  const lastSeq = log.events.at(-1).seq
  const late = [ev(lastSeq + 1, 'turn/start', { turn: 401 }), ev(lastSeq + 2, 'turn/end', { turn: 401 })]
  const files = () => {
    const file = tailFile(log.path)
    return { logPath: log.path, logKey: file.key, logSize: file.size }
  }
  const reader = tailPageReader(2, LIMITS)
  let appended = false
  const first = withReadSync((read) => (fd, buffer, offset, length, position) => {
    if (!appended && position === anchorOffset) {
      appended = true
      appendFileSync(log.path, `${late.map((event) => JSON.stringify(event)).join('\n')}\n`)
    }
    return read(fd, buffer, offset, length, position)
  }, () => reader(SID, files()))
  assert.ok(appended, 'the anchored read ran (the fixture exercises the anchor path)')
  const second = reader(SID, files())
  assert.ok(second, 'the window is readable')
  assert.ok(second.events.some((event) => event.type === 'turn/end' && event.data.turn === 401), 'the poll after the append sees the newest event')
  if (first) assert.ok(first.window.logKey !== second.window.logKey || first.events.some((event) => event.seq === lastSeq + 2), 'a cached window holds the bytes of its identity')
})

test('a prompt anchor beyond the bound falls back without reading the span', () => {
  // The page's system message's predecessor is at turn 1: the old reader read
  // and parsed nearly the whole log, then answered whole (a second parse).
  const log = makeLog({ turns: 1000, systemsAt: [1, 1000], headersAt: [1000] })
  const size = statSync(log.path).size
  let bytes = 0
  const window = withReadSync((read) => (fd, buffer, offset, length, position) => {
    const n = read(fd, buffer, offset, length, position)
    bytes += n
    return n
  }, () => readTrajectoryWindow(log.path, size, { minBytes: 1, startBytes: 64 * 1024 }))
  assert.equal(window, undefined, 'the whole parse answers')
  assert.ok(bytes < size / 2, `read ${bytes} of ${size} bytes before falling back`)
})

test('a prompt anchor inside the bound still answers a window', () => {
  const log = makeLog({ turns: 1000, systemsAt: [1, 860, 1000], headersAt: [1000] })
  const window = readTrajectoryWindow(log.path, statSync(log.path).size, { minBytes: 1, startBytes: 64 * 1024 })
  assert.ok(window, 'anchored within the bound')
  assert.ok(window.fromTurn <= 860, `anchored at turn ${window.fromTurn}`)
})

test('an unparsable line in a backward scan falls back instead of seeding an older header', () => {
  // Headers at 40, 150 and 380: the page's request at 380 is seeded from 150,
  // whose line is torn. Skipping it would seed 40, a wrong predecessor.
  const log = makeLog({ headersAt: [40, 150, 380] })
  const index = log.events.findIndex((event) => event.type === 'request/header' && event.data.header.tools[0].description === 'run 150') + 1
  const lines = [...log.lines]
  lines[index] = lines[index].slice(0, lines[index].length - 8)
  writeFileSync(log.path, `${lines.join('\n')}\n`)
  assert.ok(readFileSync(log.path, 'utf8').includes('"type":"request/header"'))
  const window = readTrajectoryWindow(log.path, statSync(log.path).size, LIMITS)
  assert.equal(window, undefined, 'the whole parse answers')
})
