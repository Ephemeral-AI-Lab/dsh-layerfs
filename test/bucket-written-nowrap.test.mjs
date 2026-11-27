// The bucket page's Written column broke "11 d ago" over two lines ("11 d" /
// "ago") while "4 h ago" fit. The cell keeps its words on one line.
//   node --test test/bucket-written-nowrap.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

test('the Written cell does not wrap', () => {
  assert.match(read('../src/client/storage/BucketPage.tsx'), /data-label=\{t\('colWritten'\)\} className=\{`\$\{css\.wide\} \$\{css\.muted\} \$\{css\.ago\}`\}/)
  assert.match(read('../src/client/storage/Storage.module.css'), /\n\.ago \{\n  white-space: nowrap;\n\}/)
})
