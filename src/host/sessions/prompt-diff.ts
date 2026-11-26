/**
 * The Trajectory's prompt diff: DSH's stock "prompt diff" is a line diff of
 * the effective system prompt and of the request's tool catalog, between two
 * consecutive recorded prompt states. It is not a message diff, and it is not
 * a diff against the session's start.
 *
 *   append system/message (in history) → a `system` change at that seq
 *   request/header with `system.update` → an unchanged system, so only tools
 *   request/header after a surface replacement → the system change at the header
 *
 * The chain is rebuilt in one pass over the same log `buildTrajectory` reads;
 * the lines themselves are produced lazily by {@link promptDiff}. Both the
 * classification and the unified hunks mirror DSH 0.2.2-rc.1's client view
 * (`structuredPatch("", "", before, after, undefined, undefined, { context: 3 })`).
 */
import { structuredPatch } from 'diff'
import type {
  PromptChangeKind, PromptDiffAnswer, PromptDiffLine, PromptDiffSection,
} from '../../shared/trajectory.ts'

/** Lines a diff keeps, hunks and context included. */
export const PROMPT_DIFF_MAX_LINES = 2000
/** UTF-8 bytes a diff keeps. */
export const PROMPT_DIFF_MAX_BYTES = 64 * 1024
/** Input lines per side; a bigger prompt or catalog is cut before diffing. */
export const PROMPT_DIFF_MAX_INPUT_LINES = 20_000

/** One recorded prompt state: the effective system text and the raw tool catalog. */
export interface PromptSnapshot {
  /** The record's seq that established this state. */
  seq: number
  system: string
  tools: readonly unknown[]
}

/** One classified prompt change, the first of a consecutive pair of prompt states. */
export interface PromptChange {
  /** The trajectory record's seq: a system/message or request/header. */
  seq: number
  kind: PromptChangeKind
  before: PromptSnapshot
  after: PromptSnapshot
  /** An in-history system append: the system text was already shown at this seq. */
  systemUpdate?: boolean
  /** The header's logged reason (`change`, `resume`, `series` …). */
  reason?: string
}

/** What one light trajectory pass needs: the change at each seq. */
export interface PromptChanges {
  changes: Map<number, PromptChange>
  flags: Map<number, { promptChanged: PromptChangeKind, previousSeq: number }>
}

interface SystemNode {
  seq: number
  text: string
  update: boolean
}

interface PlacedNode {
  /** Surface position; a replacement inherits its start endpoint. */
  position: number
  node: SystemNode
}

const integer = (value: unknown): number | undefined => Number.isInteger(value) ? value as number : undefined
const rawTools = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : []

/** A system message's text: every text block joined with the empty string, as DSH does. */
function systemText(event: any): string {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  return text
}

/** Raw JSON equality, the stock tools comparison: order and key order count. */
function sameTools(a: readonly unknown[], b: readonly unknown[]): boolean {
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

/**
 * Walk the log once and classify each recorded prompt change. A change needs a
 * predecessor: the first header (and everything before it) has none, and an
 * unchanged header yields no record. A `system/message` append after an earlier
 * nonempty system node becomes its own `system` change at its seq; its `update`
 * flag then suppresses the duplicate system report at the following header.
 */
export function promptChanges(
  events: readonly any[] | undefined, seed?: { seq: number, tools: readonly unknown[] },
): PromptChanges {
  const changes = new Map<number, PromptChange>()
  const flags = new Map<number, { promptChanged: PromptChangeKind, previousSeq: number }>()
  if (!events?.length) return { changes, flags }

  let placed: PlacedNode[] = []
  /** Replacement event seq → the position its node inherited. */
  let replacements = new Map<number, number>()
  let firstSeq: number | undefined
  let effective: SystemNode | undefined
  /**
   * The latest recorded prompt state: the baseline the next change is diffed
   * against. A window seed is the last header before it; the effective system
   * text is not recorded there, and a page `system/message` is anchored instead.
   */
  let last: PromptSnapshot | undefined = seed ? { seq: seed.seq, system: '', tools: seed.tools } : undefined

  for (const event of events) {
    const seq = integer(event?.seq)
    if (seq === undefined) continue
    const op = event?.surfaceOp
    const appended = op === 'append'
    const replaced = !!op && typeof op === 'object' && op.op === 'replace'
    const isSystem = event?.type === 'system/message'
    const isHeader = event?.type === 'request/header'
    if (!isSystem && !isHeader && !replaced) continue

    if (isSystem || replaced) {
      if (firstSeq === undefined) firstSeq = seq
      const priorEffective = effective
      let uncertain = false
      let position = seq
      if (replaced) {
        const start = integer(op.startSeq)
        const end = integer(op.endSeq)
        if (start === undefined || end === undefined || start > end) uncertain = true
        else {
          position = replacements.get(start) ?? start
          const endPosition = replacements.get(end) ?? end
          // A replacement whose endpoints predate the loaded window cannot be
          // interpreted; DSH withholds the prompt instead of guessing.
          if (firstSeq !== undefined && (position < firstSeq || endPosition < firstSeq)) uncertain = true
          else {
            placed = placed.filter((item) => item.position < position || item.position > endPosition)
            replacements = new Map([...replacements].filter(([, value]) => value < position || value > endPosition))
            replacements.set(seq, position)
          }
        }
      }
      if (uncertain) {
        placed = []
        effective = undefined
      } else {
        let introduced: SystemNode | undefined
        if (isSystem) {
          introduced = { seq, text: systemText(event), update: appended && placed.some((item) => item.node.text !== '') }
          placed = [...placed, { position, node: introduced }].sort((a, b) => a.position - b.position)
        }
        const surviving = [...placed].reverse().find((item) => item.node.text !== '')?.node
        if (surviving !== undefined && surviving === priorEffective) effective = priorEffective
        else if (surviving !== undefined && surviving === introduced) effective = introduced
        else effective = { seq, text: surviving?.text ?? '', update: false }

        // An in-history append presents the new text at its own position. A
        // replacement does not: it is classified when the next header compares
        // against it. An identical append introduces nothing.
        if (introduced?.update && last !== undefined && introduced.text !== priorEffective?.text) {
          const after: PromptSnapshot = { seq, system: introduced.text, tools: last.tools }
          const change: PromptChange = { seq, kind: 'system', before: last, after, systemUpdate: true }
          changes.set(seq, change)
          flags.set(seq, { promptChanged: 'system', previousSeq: last.seq })
          last = after
        }
      }
    }

    if (isHeader && event?.data?.header) {
      const header = event.data.header
      const current: PromptSnapshot = { seq, system: effective?.text ?? '', tools: rawTools(header.tools) }
      const previous = last
      last = current
      if (previous === undefined) continue
      // `effective.update === true` means the system text was already reported at
      // its own system/message seq; the header then reports only the tools.
      const systemChanged = previous.system !== current.system && effective?.update !== true
      const toolsChanged = !sameTools(previous.tools, current.tools)
      if (!systemChanged && !toolsChanged) continue
      const kind: PromptChangeKind = systemChanged ? 'system' : 'tools'
      const reason = typeof event.data.reason === 'string' && event.data.reason ? event.data.reason : undefined
      const change: PromptChange = { seq, kind, before: previous, after: current, ...(reason ? { reason } : {}) }
      changes.set(seq, change)
      flags.set(seq, { promptChanged: kind, previousSeq: previous.seq })
    }
  }
  return { changes, flags }
}

/** `value` cut to `max` UTF-8 bytes, ending in an ellipsis when it was. */
function clipBytes(value: string, max: number): string {
  if (Buffer.byteLength(value, 'utf8') <= max) return value
  if (max <= 1) return ''
  let out = ''
  let size = 0
  for (const ch of value) {
    const bytes = Buffer.byteLength(ch, 'utf8')
    if (size + bytes > max - 3) break
    out += ch
    size += bytes
  }
  return `${out}…`
}

/** One side cut to the input-line guard; `cut` says a huge input was shortened before diffing. */
function capInput(value: string): { text: string, cut: boolean } {
  if (!value) return { text: value, cut: false }
  const lines = value.split('\n')
  if (lines.length <= PROMPT_DIFF_MAX_INPUT_LINES) return { text: value, cut: false }
  return { text: lines.slice(0, PROMPT_DIFF_MAX_INPUT_LINES).join('\n'), cut: true }
}

/** One answer's shared line and byte budget; the system and tools sections spend it in order. */
interface DiffBudget {
  lines: number
  bytes: number
}

/**
 * One unified diff section in DSH's stock shape: a `@@ -a,b +c,d @@` meta line
 * per hunk, an empty meta line between hunks, then `+`/`-`/space-prefixed
 * lines. Kept inside the answer's shared line and byte budget; `truncated`
 * says something was cut.
 */
function diffSection(beforeValue: string, afterValue: string, budget: DiffBudget): PromptDiffSection {
  const before = capInput(beforeValue)
  const after = capInput(afterValue)
  let truncated = before.cut || after.cut
  const lines: PromptDiffLine[] = []
  const push = (line: PromptDiffLine): boolean => {
    if (budget.lines <= 0 || budget.bytes <= 0) { truncated = true; return false }
    const size = Buffer.byteLength(line.text, 'utf8') + 1
    if (size > budget.bytes) {
      lines.push({ kind: line.kind, text: clipBytes(line.text, Math.max(1, budget.bytes - 1)) })
      budget.lines--
      budget.bytes = 0
      truncated = true
      return false
    }
    lines.push(line)
    budget.lines--
    budget.bytes -= size
    return true
  }
  const patch = structuredPatch('', '', before.text, after.text, undefined, undefined, { context: 3 })
  outer: for (const [index, hunk] of patch.hunks.entries()) {
    if (index > 0 && !push({ kind: 'meta', text: '' })) break
    if (!push({ kind: 'meta', text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` })) break
    for (const raw of hunk.lines) {
      if (raw.startsWith('\\')) continue
      const kind: PromptDiffLine['kind'] = raw.startsWith('+') ? 'added' : raw.startsWith('-') ? 'removed' : 'context'
      if (!push({ kind, text: raw })) break outer
    }
  }
  return { lines, ...(truncated ? { truncated: true } : {}) }
}

/**
 * The prompt diff for one trajectory record, or undefined when the record has
 * no recorded prompt change (the first prompt, an unchanged header, a surface
 * replacement before its header). Never invents a diff against the session's
 * start.
 */
export function promptDiff(events: readonly any[] | undefined, seq: number): PromptDiffAnswer | undefined {
  if (!Number.isInteger(seq)) return undefined
  const change = promptChanges(events).changes.get(seq)
  if (!change) return undefined
  const budget: DiffBudget = { lines: PROMPT_DIFF_MAX_LINES, bytes: PROMPT_DIFF_MAX_BYTES }
  const system = change.before.system !== change.after.system
    ? diffSection(change.before.system, change.after.system, budget)
    : undefined
  const toolsBefore = JSON.stringify(change.before.tools, null, 2) ?? ''
  const toolsAfter = JSON.stringify(change.after.tools, null, 2) ?? ''
  const tools = toolsBefore !== toolsAfter ? diffSection(toolsBefore, toolsAfter, budget) : undefined
  if (!system && !tools) return undefined
  return {
    seq,
    ...(system ? { system } : {}),
    ...(tools ? { tools } : {}),
    before: { seq: change.before.seq },
    after: { seq: change.after.seq },
    ...(system?.truncated || tools?.truncated ? { truncated: true } : {}),
  }
}
