/** How a log line's session label reads: turn, checkpoint kind, `references`. */
import type { CallLabel } from '../../shared/logs.ts'
import type { LogsT } from './locale.ts'

/** The checkpoint a line saved or referenced, in words, or undefined. */
export function checkpointWords(label: CallLabel, t: LogsT): string | undefined {
  const c = label.checkpoint
  if (!c) return undefined
  const kind = c.kind === 'base' ? t('kindBase') : c.kind === 'turn' ? t('kindTurn') : c.kind === 'manual' ? t('kindManual') : c.kind === 'restore' ? t('kindRestore') : c.kind === 'idle' ? t('kindIdle') : c.kind
  // A restore or a branch base points at an existing version; it never saves one.
  if (c.kind === 'restore' || c.kind === 'base') return label.match === 'tag' ? `${kind} · ${t('references')}` : kind
  return label.match === 'tag' && !c.saved && c.changed === 0 ? `${kind} · ${t('unchanged')}` : kind
}

/** The words after the session's name: `references`, turn, checkpoint, origin. */
export function sessionParts(label: CallLabel, t: LogsT): string[] {
  // The checkpoint's turn (a restore names the turn it went back to), else the call's.
  const turn = label.checkpoint?.turn ?? label.turn
  return [
    label.match === 'commit' ? t('references') : undefined,
    turn !== undefined ? t('turn', { n: turn }) : undefined,
    checkpointWords(label, t),
    label.origin && !label.checkpoint ? t(label.origin === 'host' ? 'originHost' : 'originTool') : undefined,
  ].filter((part): part is string => !!part)
}
