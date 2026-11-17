/**
 * A piece's verdict as the setup modal words it. LayerFS's `matches` rule says
 * "can't tell" whenever a piece's commit or cleanliness is unknown; for pieces
 * built before LayerFS stamped its builds that hides what is known, so an
 * unknown verdict is split by what the piece does record:
 *   - the CLI's own commit, without whether it was clean: "Same commit"
 *   - no commit at all (a daemon without a build stamp): "No build stamp"
 *   - anything else (the CLI's commit is unknown): "Can't tell"
 * Neither blocks setup, as before.
 */
import type { Piece, Verdict } from './store.ts'

export type VerdictKey = 'vMatches' | 'vOther' | 'vUnknown' | 'vMissing' | 'vSameCommit' | 'vNoStamp'

export interface VerdictWords {
  /** The tone, as `data-verdict` (the old-build words keep the neutral unknown tone). */
  readonly tone: Verdict
  readonly key: VerdictKey
}

export function verdictWords(piece: Pick<Piece, 'verdict' | 'commit'> | null | undefined, cliCommit: string | null | undefined): VerdictWords {
  const tone = piece?.verdict ?? 'missing'
  if (tone === 'matches') return { tone, key: 'vMatches' }
  if (tone === 'other') return { tone, key: 'vOther' }
  if (tone === 'missing') return { tone, key: 'vMissing' }
  if (!piece?.commit) return { tone, key: 'vNoStamp' }
  if (cliCommit && piece.commit === cliCommit) return { tone, key: 'vSameCommit' }
  return { tone, key: 'vUnknown' }
}
