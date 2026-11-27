// The LayerFS trajectory's live assistant text: the delta reducer, the frame
// coalescer, the merge into the answer's turns, and the rendered row while a
// step runs (mini-react). The feed is the public SessionBinding.eventSource
// window (`assistant/live-chunk` transients), not a new host seam.
//   node --test test/trajectory-streaming.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { miniReact } from './mini-react.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'lib'), { recursive: true })
const out = mkdtempSync(join(root, 'lib', '.test-trajectory-streaming-'))
await build({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { mount, text } from 'react'",
      "import { useLiveSteps, LiveStepSource, mergeLiveSteps } from './src/client/views/live-step.ts'",
      "import { RecordText } from './src/client/views/TrajectoryView.tsx'",
      "export { TrajectoryView } from './src/client/views/TrajectoryView.tsx'",
      "export { LiveStepSource, mergeLiveSteps }",
      "export let renderCount = 0",
      "export const resetRenders = () => { renderCount = 0 }",
      "export function StreamingProbe(props) {",
      "  renderCount++",
      "  const live = useLiveSteps(props.liveStep)",
      "  const turns = mergeLiveSteps(props.turns, live)",
      "  const record = turns.flatMap((turn) => turn.records).find((r) => r.kind === 'assistant')",
      "  if (!record) return null",
      "  return RecordText({ record, t: props.t })",
      "}",
    ].join('\n'),
    resolveDir: root, loader: 'tsx',
  },
  outfile: join(out, 'streaming.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node24', logLevel: 'error',
  jsx: 'automatic', loader: { '.module.css': 'local-css', '.css': 'css' }, plugins: [miniReact],
})
const M = await import(pathToFileURL(join(out, 'streaming.mjs')).href)
test.after(() => rmSync(out, { recursive: true, force: true }))

// ------------------------------------------------------------ the fake feed

/** The controller's window, with the same deltas its event source publishes. */
function fakeFeed() {
  let current = { entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } }
  const listeners = new Set()
  return {
    source: {
      getSnapshot: () => current,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    },
    publish(change) {
      if (change.kind === 'replace') current = { entries: change.entries, hasMore: false, revision: current.revision + 1, change }
      else if (change.kind === 'append') current = { ...current, entries: [...current.entries, ...change.entries], revision: current.revision + 1, change }
      else if (change.kind === 'prepend') current = { ...current, entries: [...change.entries, ...current.entries], revision: current.revision + 1, change }
      else if (change.kind === 'settle-assistant') {
        const entries = current.entries.filter((entry) => entry.type !== 'transient' || entry.event.data.attemptId !== change.attemptId)
        current = { ...current, entries: change.entry ? [...entries, change.entry] : entries, revision: current.revision + 1, change }
      }
      for (const listener of [...listeners]) listener()
    },
  }
}

/** A scheduler the test fires by hand, so a burst is one frame. */
function manualScheduler() {
  const runs = []
  return {
    get pending() { return runs.filter(Boolean).length },
    schedule: (run) => { runs.push(run); return runs.length - 1 },
    cancel: (token) => { runs[token] = undefined },
    flush() {
      while (runs.length) {
        const run = runs.shift()
        if (run) run()
      }
    },
  }
}

/** One transient text delta, as the controller publishes it. */
const live = (attemptId, turn, step, text, index = 0, time = 1000) => ({
  type: 'transient',
  event: {
    type: 'assistant/live-chunk', seq: 0, time,
    data: { attemptId, turn, step, chunk: { type: 'text-delta', index, text } },
  },
})

/** One durable session event entry. */
const durable = (type, turn, step, data = {}, time = 2000) => ({
  type: 'event',
  event: { type, seq: 100, time, data: { turn, step, ...data } },
})

const finalMessage = (turn, step, text, extra = {}) => durable('assistant/message', turn, step, {
  message: { content: [{ type: 'text', text }] }, ...extra,
})

const append = (...entries) => ({ kind: 'append', entries })

/** A source over a fresh fake feed, with a hand-fired scheduler. */
function harness() {
  const feed = fakeFeed()
  const scheduler = manualScheduler()
  const source = new M.LiveStepSource(feed.source, { frameMs: 0, schedule: scheduler.schedule, cancel: scheduler.cancel })
  let notifications = 0
  const off = source.subscribe(() => { notifications++ })
  return {
    feed, scheduler, source,
    get notifications() { return notifications },
    step: () => source.getSnapshot().current,
    stop: off,
  }
}

// --------------------------------------------------------------- the reducer

test('the delta reducer appends chunks in order, starts a new step fresh, and is replaced by the final message', () => {
  const h = harness()
  h.feed.publish(append(live('a1', 1, 1, 'Hel', 0, 1000)))
  h.scheduler.flush()
  assert.equal(h.step().text, 'Hel', 'the first delta is visible')

  h.feed.publish(append(live('a1', 1, 1, 'lo', 0, 1001), live('a1', 1, 1, ' world', 0, 1002)))
  h.scheduler.flush()
  assert.equal(h.step().text, 'Hello world', 'chunks append in order')
  assert.equal(h.step().running, true)
  assert.equal(h.source.getSnapshot().previous, null)

  // A second text block starts a paragraph, as DSH's trajectory joins blocks.
  h.feed.publish(append(live('a1', 1, 1, 'Next paragraph', 2, 1003)))
  h.scheduler.flush()
  assert.equal(h.step().text, 'Hello world\n\nNext paragraph')

  // A new step: the new one starts clean, the settled one is kept for the log gap.
  h.feed.publish(append(live('a2', 1, 2, 'Second step', 0, 1100)))
  h.scheduler.flush()
  assert.equal(h.step().step, 2)
  assert.equal(h.step().text, 'Second step', 'a new step resets the text')
  assert.equal(h.source.getSnapshot().previous.text, 'Hello world\n\nNext paragraph', 'the previous step is kept')

  // The durable message replaces the streamed text and ends the step.
  h.feed.publish(append(finalMessage(1, 2, 'The final answer')))
  h.scheduler.flush()
  assert.equal(h.step().text, 'The final answer', 'the message text replaces the streamed text')
  assert.equal(h.step().running, false)
  assert.equal(h.notifications, 5, 'one frame per pushed batch')

  // A retry within the same step restarts the text.
  h.feed.publish(append(live('a3', 1, 3, 'attempt one', 0, 1200), live('a3', 1, 3, ' and more', 0, 1201)))
  h.scheduler.flush()
  assert.equal(h.step().text, 'attempt one and more')
  h.feed.publish(append(live('a4', 1, 3, 'retried', 0, 1300)))
  h.scheduler.flush()
  assert.equal(h.step().attemptId, 'a4')
  assert.equal(h.step().text, 'retried', 'a retry starts the step text over')

  // A replacement window (reconnect) is folded from scratch.
  h.feed.publish({ kind: 'replace', entries: [live('b1', 2, 1, 'Reconnected', 0, 1400)] })
  h.scheduler.flush()
  assert.equal(h.step().text, 'Reconnected')
  assert.equal(h.source.getSnapshot().previous, null)
  h.stop()
})

test('the cap keeps the first 64 KiB of a step and says it was truncated', () => {
  const h = harness()
  h.feed.publish(append(live('a1', 1, 1, 'x'.repeat(1024), 0, 1000)))
  h.scheduler.flush()
  h.feed.publish(append(live('a1', 1, 1, 'y'.repeat(70 * 1024), 0, 1001)))
  h.scheduler.flush()
  const step = h.step()
  assert.equal(step.text.length, 64 * 1024, 'at most MAX_LIVE_TEXT is kept')
  assert.equal(step.truncated, true)

  // Later text does not grow the buffer or change what is drawn.
  h.feed.publish(append(live('a1', 1, 1, 'more', 0, 1002)))
  h.scheduler.flush()
  assert.equal(h.step().text.length, 64 * 1024)
  assert.equal(h.step().truncated, true)
  h.stop()
})

// ------------------------------------------------------------- the coalescer

test('20 chunks in one frame are one publication, and a hidden tab schedules nothing', () => {
  const feed = fakeFeed()
  const scheduler = manualScheduler()
  let visible = true
  let onVisible
  const source = new M.LiveStepSource(feed.source, {
    frameMs: 0,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    visible: () => visible,
    listenVisible: (fn) => { onVisible = fn; return () => { onVisible = undefined } },
  })
  let notifications = 0
  const off = source.subscribe(() => { notifications++ })

  for (let i = 0; i < 20; i++) feed.publish(append(live('a1', 1, 1, `${i},`, 0, 1000 + i)))
  assert.equal(scheduler.pending, 1, 'the burst scheduled one frame')
  assert.equal(notifications, 0, 'nothing renders before the frame')
  scheduler.flush()
  assert.equal(notifications, 1, '20 chunks in one frame are one render')
  assert.equal(source.getSnapshot().current.text, Array.from({ length: 20 }, (_, i) => `${i},`).join(''))

  // A background tab: deltas fold, but no timer and no render is queued.
  visible = false
  for (let i = 0; i < 3; i++) feed.publish(append(live('a1', 1, 1, 'bg', 0, 2000 + i)))
  assert.equal(scheduler.pending, 0, 'a hidden tab schedules no frame')
  assert.equal(notifications, 1)
  assert.match(source.getSnapshot().current.text, /bgbgbg$/, 'the text is still folded')

  // Back on screen: one catch-up render with the latest text.
  visible = true
  onVisible()
  assert.equal(notifications, 2, 'becoming visible publishes once')
  off()
})

test('chunks published between the render\'s read and the subscribe are folded, not lost', () => {
  const feed = fakeFeed()
  const scheduler = manualScheduler()
  const source = new M.LiveStepSource(feed.source, {
    frameMs: 0, schedule: scheduler.schedule, cancel: scheduler.cancel,
    visible: () => true, listenVisible: () => () => {},
  })
  feed.publish(append(live('a1', 1, 1, 'Hel', 0, 1000)))
  // useLiveSteps reads the snapshot during render ...
  assert.equal(source.getSnapshot().current.text, 'Hel', 'the render folds the window')
  // ... the feed moves before the effect subscribes (nobody is listening yet) ...
  feed.publish(append(live('a1', 1, 1, 'lo', 0, 1001)))
  feed.publish(append(live('a1', 1, 1, ' wor', 0, 1002)))
  assert.equal(source.getSnapshot().current.text, 'Hello wor', 'the effect\'s read sees the chunks since the render')
  let notifications = 0
  const off = source.subscribe(() => { notifications++ })
  // ... and the next delta applies on top of all of them.
  feed.publish(append(live('a1', 1, 1, 'ld', 0, 1003)))
  scheduler.flush()
  assert.equal(notifications, 1)
  assert.equal(source.getSnapshot().current.text, 'Hello world', 'no chunk between render and subscribe is lost')

  // Changes while nobody listens (the last listener left) are read on the next subscribe.
  off()
  feed.publish(append(live('a1', 1, 1, '!', 0, 1004)))
  feed.publish(append(live('a1', 1, 1, '?', 0, 1005)))
  const again = source.subscribe(() => { notifications++ })
  feed.publish(append(live('a1', 1, 1, '.', 0, 1006)))
  scheduler.flush()
  assert.equal(source.getSnapshot().current.text, 'Hello world!?.', 'a resubscribe reads the changes it missed')
  again()
})

test('reduced motion still publishes the running text and the step\'s end, at most once a second', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia')
  // The default seams: a reader who asked for reduced motion, on a visible page.
  globalThis.matchMedia = (query) => ({
    matches: query === '(prefers-reduced-motion: reduce)', media: query,
    addEventListener() {}, removeEventListener() {},
  })
  try {
    const feed = fakeFeed()
    const delays = []
    const scheduler = manualScheduler()
    const source = new M.LiveStepSource(feed.source, {
      frameMs: 100,
      schedule: (run, ms) => { delays.push(ms); return scheduler.schedule(run) },
      cancel: scheduler.cancel,
    })
    let notifications = 0
    const off = source.subscribe(() => { notifications++ })
    feed.publish(append(live('a1', 1, 1, 'Hello', 0, 1000)))
    feed.publish(append(live('a1', 1, 1, ' world', 0, 1001)))
    assert.equal(scheduler.pending, 1, 'one throttled frame is queued')
    scheduler.flush()
    assert.equal(notifications, 1, 'the content update is published')
    assert.equal(source.getSnapshot().current.text, 'Hello world')
    assert.ok(delays.every((ms) => ms >= 1000), `frames are throttled to once a second (${delays})`)

    feed.publish(append(finalMessage(1, 1, 'Hello world.')))
    scheduler.flush()
    assert.equal(notifications, 2, 'the step\'s end reaches the view')
    assert.equal(source.getSnapshot().current.running, false)
    off()
  } finally {
    if (had) Object.defineProperty(globalThis, 'matchMedia', had)
    else delete globalThis.matchMedia
  }
})

// ----------------------------------------------------------------- the merge

test('the merge places a live step before its tool calls and leaves the log record alone once it arrives', () => {
  const turns = [{
    turn: 1, at: 100,
    records: [
      { kind: 'user', seq: 1, turn: 1, source: 'user', text: 'go', at: 100 },
      { kind: 'request', seq: 2, turn: 1, step: 1, tools: 2, summary: 'model · 2 tools', at: 105 },
      { kind: 'tool', seq: 3, turn: 1, step: 1, callId: 'c1', name: 'bash', ops: [], at: 106 },
    ],
    orphanCalls: [], hostOps: [], checkpoints: [],
  }]
  const steps = {
    current: { attemptId: 'a1', turn: 1, step: 1, text: 'streamed words', running: true, truncated: false, blocks: [0], startedAt: 150, at: 160 },
    previous: null,
  }
  const merged = M.mergeLiveSteps(turns, steps)
  const liveRecord = merged[0].records[2]
  assert.equal(liveRecord.kind, 'assistant')
  assert.equal(liveRecord.live, true)
  assert.equal(liveRecord.streaming, true)
  assert.equal(liveRecord.text, 'streamed words')
  assert.equal(liveRecord.seq < 0, true, 'the synthetic row has a client-only seq')
  assert.equal(liveRecord.startedAt, 150)
  assert.deepEqual(merged[0].records.map((r) => r.kind), ['user', 'request', 'assistant', 'tool'], 'the step sits before its tool calls')

  // The log now has the step's message: the streamed row is not added again.
  const logged = [{
    ...turns[0],
    records: [...turns[0].records, { kind: 'assistant', seq: 9, turn: 1, step: 1, text: 'from the log', toolCalls: 0 }],
  }]
  assert.equal(M.mergeLiveSteps(logged, steps), logged, 'a logged step suppresses the live row (no duplicate)')

  // A live turn the answer has not read yet still gets its row.
  const fresh = M.mergeLiveSteps([], { current: { ...steps.current, turn: 4, step: 1 }, previous: null })
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].turn, 4)
  assert.equal(fresh[0].records[0].live, true)
  assert.equal(M.mergeLiveSteps(turns, { current: null, previous: null }), turns, 'no live step leaves the turns untouched')
})

// ------------------------------------------------------------------ rendering

test('the view renders the streamed text while the step runs and the log text replaces it', async () => {
  const feed = fakeFeed()
  const scheduler = manualScheduler()
  const source = new M.LiveStepSource(feed.source, { frameMs: 0, schedule: scheduler.schedule, cancel: scheduler.cancel })
  let notifications = 0
  const counted = {
    getSnapshot: () => source.getSnapshot(),
    subscribe: (listener) => source.subscribe(() => { notifications++; listener() }),
  }
  const t = (key) => key
  const turns = [{
    turn: 1, at: 100,
    records: [{ kind: 'user', seq: 1, turn: 1, source: 'user', text: 'go', at: 100 }],
    orphanCalls: [], hostOps: [], checkpoints: [],
  }]
  const props = { liveStep: counted, turns, t }
  const view = M.mount(M.StreamingProbe, props)
  await view.settle()
  assert.equal(M.text(view.tree), '', 'nothing streams before the step does')

  M.resetRenders()
  for (let i = 0; i < 20; i++) feed.publish(append(live('a1', 1, 1, `chunk${i} `, 0, 1000 + i)))
  assert.equal(scheduler.pending, 1)
  scheduler.flush()
  await view.settle()
  assert.equal(notifications, 1, '20 chunks caused one publication')
  assert.equal(M.renderCount, 1, 'and one render')
  const streamed = M.text(view.tree)
  assert.match(streamed, /chunk0 chunk1 /, 'the growing text is on screen')
  assert.match(streamed, /chunk19/)
  assert.match(streamed, /trajStreaming/, 'the running marker is on screen')

  // The next `session.trajectory` read has the step: the log's text replaces the stream.
  const logged = [{
    ...turns[0],
    records: [...turns[0].records, { kind: 'assistant', seq: 9, turn: 1, step: 1, text: 'From the log.', toolCalls: 0 }],
  }]
  view.render({ ...props, turns: logged })
  await view.settle()
  const final = M.text(view.tree)
  assert.match(final, /From the log\./, 'the log text is shown')
  assert.doesNotMatch(final, /chunk0/, 'the streamed text is gone')
  assert.doesNotMatch(final, /trajStreaming/, 'the running marker is gone')
  assert.equal(final.match(/From the log\./g).length, 1, 'one row: no duplicate')
  view.unmount()
})

test('a streaming burst does not re-read session.trajectory', async () => {
  const feed = fakeFeed()
  const scheduler = manualScheduler()
  const source = new M.LiveStepSource(feed.source, { frameMs: 0, schedule: scheduler.schedule, cancel: scheduler.cancel })
  let notifications = 0
  const counted = {
    getSnapshot: () => source.getSnapshot(),
    subscribe: (listener) => source.subscribe(() => { notifications++; listener() }),
  }
  const reads = []
  const answer = {
    sessionId: 's1', project: 'p', branch: 'b', logLoaded: true, counts: { versionsCreated: 0, callsWithVersions: 0 },
    turns: [{ turn: 1, at: 100, records: [{ kind: 'user', seq: 1, turn: 1, source: 'user', text: 'go', at: 100 }], orphanCalls: [], hostOps: [], checkpoints: [] }],
  }
  const api = {
    op: async (name) => {
      assert.equal(name, 'session.trajectory')
      reads.push(name)
      return answer
    },
    onEvent: () => () => {},
  }
  const view = M.mount(M.TrajectoryView, {
    api, t: (key) => key, sessionId: 's1', liveStep: counted,
    sessions: { getSnapshot: () => ({ byId: { s1: { running: false } } }), subscribe: () => () => {} },
    hideComposer: () => () => {},
  })
  await view.settle()
  assert.equal(reads.length, 1, 'the mount read the trajectory once')

  for (let i = 0; i < 20; i++) feed.publish(append(live('a1', 1, 1, `chunk${i} `, 0, 1000 + i)))
  scheduler.flush()
  await view.settle()
  assert.equal(notifications, 1)
  assert.equal(reads.length, 1, 'streaming chunks append client-side; no extra host read')
  view.unmount()
})
