// On a phone each Logs call is a card without column headers: its empty Saved
// and Session cells drew a bare "— —" line on every row. They are marked empty
// and not drawn in the card layout; the desktop table keeps its dashes.
//   node --test test/logs-phone-empty-cells.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

test('empty Saved and Session cells are marked empty', () => {
  const page = read('../src/client/logs/LogsPage.tsx')
  assert.match(page, /className=\{clsx\(css\.saved, css\.wSaved\)\} data-empty=\{version \? undefined : ''\}/)
  assert.match(page, /<td role="cell" data-empty=\{line\.dsh \? undefined : ''\}>\{line\.dsh \? <SessionLabel/)
})

test('the phone card layout does not draw an empty cell, after the cell placements', () => {
  const styles = read('../src/client/logs/logs.module.css')
  const card = styles.slice(styles.indexOf('@container (max-width: 834px)'))
  const hide = card.indexOf('.table td[data-empty] { display: none; }')
  assert.ok(hide > 0, 'the card layout hides empty cells')
  // same specificity as the placements: it must come after them to win
  assert.ok(hide > card.indexOf('.table td:nth-child(6)') && hide > card.indexOf('.table td:nth-child(7)'))
  // the desktop table does not hide them
  assert.ok(!styles.slice(0, styles.indexOf('@container (max-width: 834px)')).includes('td[data-empty]'))
})
