// The Overview's Projects tab search and sort (src/client/storage/project-list.ts).
//   node --test test/project-list.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SORT, orderProjects, projectMatches, sessionOrder, sizeOrder } from '../src/client/storage/project-list.ts'

const items = [
  { store: 'demo-studio', project: 'website' },
  { store: 'qv2-store', project: 'qv2-strata' },
  { store: 'demo-studio', project: 'design' },
  { store: 'pg', project: 'billing' },
]
const keys = items.map((i) => `${i.store}/${i.project}`)

test('a search keeps a project by its name or its Store name, in any case', () => {
  assert.ok(projectMatches('demo-studio', 'website', 'WEB'))
  assert.ok(projectMatches('demo-studio', 'website', ' studio '))
  assert.ok(!projectMatches('demo-studio', 'website', 'qv2'))
  assert.ok(projectMatches('s', 'p', '   '), 'blank keeps everything')
  assert.deepEqual(orderProjects(items, 'demo', 'default', null).map((i) => i.project), ['website', 'design'])
})

test('size order: largest first, projects without a size last in their given order', () => {
  const size = { 'demo-studio/website': 33_900, 'qv2-store/qv2-strata': 4.8e9, 'demo-studio/design': null, 'pg/billing': null }
  assert.deepEqual(sizeOrder(keys, (k) => size[k]), ['qv2-store/qv2-strata', 'demo-studio/website', 'demo-studio/design', 'pg/billing'])
})

test('orderProjects: default keeps the given order, name sorts A to Z, size follows the frozen order', () => {
  assert.deepEqual(orderProjects(items, '', 'default', null), items)
  assert.deepEqual(orderProjects(items, '', 'name', null).map((i) => i.project), ['billing', 'design', 'qv2-strata', 'website'])
  const frozen = ['qv2-store/qv2-strata', 'demo-studio/design']
  // a project missing from the frozen order (new, or unsized then) goes last, in the given order
  assert.deepEqual(orderProjects(items, '', 'size', frozen).map((i) => i.project), ['qv2-strata', 'design', 'website', 'billing'])
  assert.deepEqual(orderProjects(items, '', 'size', null), items, 'no order yet: default')
  assert.deepEqual(orderProjects(items, 'demo', 'size', frozen).map((i) => i.project), ['design', 'website'])
})

test('last session order: newest session first, projects without one last in the given order; it is the default sort', () => {
  const last = { 'demo-studio/website': 2_000, 'qv2-store/qv2-strata': null, 'demo-studio/design': 9_000, 'pg/billing': null }
  const frozen = sessionOrder(keys, (k) => last[k])
  assert.deepEqual(frozen, ['demo-studio/design', 'demo-studio/website', 'qv2-store/qv2-strata', 'pg/billing'])
  assert.deepEqual(orderProjects(items, '', 'session', frozen).map((i) => i.project), ['design', 'website', 'qv2-strata', 'billing'])
  // the frozen order holds while sessions keep writing: a later answer does not move rows until the order is worked out again
  assert.deepEqual(orderProjects(items, '', 'session', frozen).map((i) => i.project), ['design', 'website', 'qv2-strata', 'billing'])
  assert.deepEqual(orderProjects(items, '', 'session', null), items, 'no order yet: default')
  assert.equal(DEFAULT_SORT, 'session')
})
