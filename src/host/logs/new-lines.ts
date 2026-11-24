/**
 * What a `logs` event can say about the call-log lines appended since the last
 * one: the session tags they carry. CLI and SDK calls are appended by separate
 * processes (`layerfs/tracing.ts`, `layerfs/agent-sdk.ts`), so the host learns
 * about them from the file, not from an in-process append hook.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'

/** Where the last read stopped: the file identity and the offset read to. */
export interface Cursor { ino: number, size: number }

/**
 * The `tag`s of the lines appended since `held` was last read, duplicates
 * included, in order. An empty array means nothing was appended; `null` means
 * the window cannot be attributed to specific calls (the file rotated, a line
 * was still being written, or a line has no tag): the caller refreshes
 * everything rather than risk missing a view.
 *
 * The cursor advances past every complete line read, so a partial trailing line
 * is read whole next time; on rotation (another inode, or a shorter file) it
 * resets to the current end, since the lines moved are no longer readable.
 */
export function readNewCallTags(path: string, held: { value: Cursor | null }): string[] | null {
  let st: { ino: number, size: number }
  try { st = statSync(path) } catch { held.value = null; return [] }
  const from = held.value
  // First look (or the file vanished): start at the end; nothing before it is new.
  if (!from) { held.value = { ino: st.ino, size: st.size }; return [] }
  if (st.ino !== from.ino || st.size < from.size) {
    held.value = { ino: st.ino, size: st.size }
    return null
  }
  if (st.size === from.size) return []
  const length = st.size - from.size
  const buffer = Buffer.alloc(length)
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    readSync(fd, buffer, 0, length, from.size)
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
  const end = buffer.lastIndexOf(0x0a)
  // No newline: the writer is mid-line. Read it again once it is complete.
  if (end < 0) return null
  held.value = { ino: st.ino, size: from.size + end + 1 }
  const tags: string[] = []
  for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
    if (!line) continue
    let row: any
    try { row = JSON.parse(line) } catch { return null }
    if (typeof row?.tag !== 'string' || !row.tag) return null
    tags.push(row.tag)
  }
  return tags
}
