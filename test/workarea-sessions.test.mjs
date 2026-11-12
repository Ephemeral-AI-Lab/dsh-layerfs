import { test } from 'node:test'
import assert from 'node:assert/strict'
import { visibleProjectSessions } from '../src/client/workareas/session-visibility.ts'

test('project history hides unused drafts, retaining started and stored conversations', () => {
  const sessions = [{ sessionId: 'empty' }, { sessionId: 'greeting' }, { sessionId: 'untitled-but-started' }, { sessionId: 'stored' }]
  const summaries = { empty: { blank: true }, greeting: { blank: false }, 'untitled-but-started': { blank: false } }
  assert.deepEqual(visibleProjectSessions(sessions, summaries).map((s) => s.sessionId), ['greeting', 'untitled-but-started', 'stored'])
  summaries.empty.blank = false
  assert.equal(visibleProjectSessions(sessions, summaries).length, 4, 'the draft appears after its first turn')
})
