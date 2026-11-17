/**
 * A piece's verdict as the setup modal words it. LayerFS's `matches` rule says
 * "can't tell" whenever a piece's commit or cleanliness is unknown; for pieces
 * built before LayerFS stamped its builds that hides what is known, so an
 * unknown verdict is split by what the piece does record:
 *   - the CLI's own commit, without whether it was clean: "Same commit"
 *   - no commit at all (a daemon without a build stamp): "No build stamp"
 *   - anything else (the CLI's commit is unknown): "Can't tell"
 * Both old-build words carry a note; neither blocks setup, as before.
 */
import type { Piece, Verdict } from './store.ts'

export type VerdictKey = 'vMatches' | 'vOther' | 'vUnknown' | 'vMissing' | 'vSameCommit' | 'vNoStamp'
export type VerdictNoteKey = 'vSameCommitNote' | 'vNoStampNote'

export interface VerdictWords {
  /** The tone, as `data-verdict` (the old-build words keep the neutral unknown tone). */
  readonly tone: Verdict
  readonly key: VerdictKey
  readonly note: VerdictNoteKey | null
}

export function verdictWords(piece: Pick<Piece, 'verdict' | 'commit'> | null | undefined, cliCommit: string | null | undefined): VerdictWords {
  const tone = piece?.verdict ?? 'missing'
  if (tone === 'matches') return { tone, key: 'vMatches', note: null }
  if (tone === 'other') return { tone, key: 'vOther', note: null }
  if (tone === 'missing') return { tone, key: 'vMissing', note: null }
  if (!piece?.commit) return { tone, key: 'vNoStamp', note: 'vNoStampNote' }
  if (cliCommit && piece.commit === cliCommit) return { tone, key: 'vSameCommit', note: 'vSameCommitNote' }
  return { tone, key: 'vUnknown', note: null }
}
