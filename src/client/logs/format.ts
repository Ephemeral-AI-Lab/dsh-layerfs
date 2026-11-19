/**
 * Display helpers for the Logs page and its call detail: durations, times,
 * the command split into its words, and stored outputs made readable.
 */
import { shellCommand } from '../../shared/logs.ts'
import type { LogsT } from './locale.ts'
import { dateTime } from '../ui/locale-sync.ts'

const KIND_WORDS: Record<string, string> = { committed: 'kindCommitted', uptodate: 'kindUpToDate', unchanged: 'kindUpToDate', forked: 'kindForked', merged: 'kindMerged', added: 'kindAdded' }

/** A line's `kind` (what the call saved: `Committed`, `UpToDate`, …) in the page's words (B2 #5); another word as it came. */
export function kindWords(kind: string, t: LogsT): string {
  const key = KIND_WORDS[kind.toLowerCase().replace(/[^a-z]/g, '')]
  return key ? t(key as Parameters<LogsT>[0]) : kind
}

/** A duration as people read it: `212 ms`, `1.2 s`, `14 s`, `2 min 5 s`. */
export function duration(ms: number, t: LogsT): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return t('durMs', { n: Math.round(ms) })
  if (ms < 10_000) return t('durS', { n: (Math.round(ms / 100) / 10).toFixed(1) })
  if (ms < 60_000) return t('durS', { n: Math.round(ms / 1000) })
  const s = Math.round(ms / 1000)
  return t('durMin', { m: Math.floor(s / 60), s: s % 60 })
}

/** Local date and time with milliseconds (`Nov 12, 2026, 14:03:07.412`). */
export function absoluteTime(at: number): string {
  return dateTime(at, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
  })
}

/** The command as display words: `layerfs`, the operation (`file write`), the rest. */
export interface CommandParts {
  full: string
  verb: string
  rest: string
}

export function commandParts(argv: readonly string[]): CommandParts {
  const full = shellCommand(argv)
  // shellCommand quotes word by word and joins with spaces, so the head is a prefix of the whole.
  const head = shellCommand(argv.slice(0, 2))
  return { full, verb: head.slice('layerfs'.length).trim(), rest: full.slice(head.length) }
}

/** `family call` of a line, for headings. */
export function operationWords(argv: readonly string[]): string {
  return [argv[0], argv[1]].filter(Boolean).join(' ')
}

/** Stored output made readable: JSON pretty-printed, anything else as it came. */
export function readable(text: string): { text: string, json: boolean } {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return { text: JSON.stringify(JSON.parse(trimmed), null, 2), json: true } } catch { /* raw below */ }
  }
  return { text, json: false }
}

/** Any value as indented JSON text. */
export function jsonText(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return String(value) }
}
