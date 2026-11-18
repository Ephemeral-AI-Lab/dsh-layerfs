/**
 * What the Set up LayerFS modal says, as data (docs/specs/layerfs-setup.md
 * §4.1): two sections, each a short list of rows.
 *
 *   LayerFS   the folder, and the build: one row saying whether the CLI,
 *             daemon and Linux bundle come from one build (the per-piece
 *             table is behind Details)
 *   Machines  one row per platform this computer can run (home get --with platforms):
 *             Ready / Available, or why not and the one thing to do, Install…
 *             (or Set up…) for a missing tool or host fact, Check for an
 *             installed tool that does not answer. No Add here: making a
 *             machine belongs to the Machines page.
 *
 * Pure (types only), so test/setup-summary.test.mjs runs it without React.
 */
import type { MachinePlatformInfo } from '../machines/model.ts'
import { readinessOf, type HostOs, type NeedContext, type Readiness } from '../machines/needs.ts'
import type { SetupKey } from './locale.ts'
import type { Piece, SetupStatus } from './store.ts'

export const short = (commit: string | null | undefined): string => (commit ? commit.slice(0, 8) : '—')

/** The build row's state: nothing chosen, unusable, pieces from other builds, a piece missing, or ready. */
export type BuildState = 'none' | 'failed' | 'mixed' | 'incomplete' | 'ready'

export interface BuildWords {
  readonly state: BuildState
  /** The row's state word. */
  readonly word: SetupKey
  /** The row's line under the title, only when something is wrong (null: the state word says it all). */
  readonly line: SetupKey | null
  readonly values: Record<string, string>
}

const pieceKey = { daemon: 'pieceDaemon', bundle: 'pieceBundle' } as const

/**
 * The build row: a state word, and a few words only when something is wrong.
 * `pieceName` names a piece ("Linux bundle"), so the caller's dictionary
 * decides the words. Pieces built before build stamps (an unknown verdict)
 * pass, as Done does; Details says what each of them records.
 */
export function buildWords(s: SetupStatus, pieceName: (key: 'pieceDaemon' | 'pieceBundle') => string): BuildWords {
  const r = s.runtime, p = s.pieces
  if (!r.cli) return { state: 'none', word: 'sumNoRuntime', line: null, values: {} }
  if (!r.ok) return { state: 'failed', word: 'sumRuntimeFailed', line: 'buildFailed', values: { message: r.error?.message ?? '' } }
  const pieces: ['daemon' | 'bundle', Piece | null][] = [['daemon', p.daemon], ['bundle', p.bundle]]
  const other = pieces.filter(([, x]) => x?.verdict === 'other')
  if (other.length === 1) {
    const [name, piece] = other[0]!
    return { state: 'mixed', word: 'sumMixed', line: 'buildMixedOne', values: { piece: pieceName(pieceKey[name]), theirs: short(piece!.commit) } }
  }
  if (other.length > 1) return { state: 'mixed', word: 'sumMixed', line: 'buildMixedBoth', values: {} }
  // the bundle is always a piece (null = none found); the daemon only where a native daemon applies (macOS)
  if (!p.bundle || p.bundle.verdict === 'missing') return { state: 'incomplete', word: 'buildIncomplete', line: 'buildNoBundle', values: {} }
  if (p.daemon && p.daemon.verdict === 'missing') return { state: 'incomplete', word: 'buildIncomplete', line: 'buildNoDaemon', values: {} }
  return { state: 'ready', word: 'stateReady', line: null, values: {} }
}

/** A platform row's state word. */
export type PlatformState = 'ready' | 'available' | 'notInstalled' | 'notRunning' | 'needsSetup' | 'needsBundle'
/** A platform row's one action: a how-to with Check (install or set up), Check alone (start), or none. */
export type PlatformAction = 'install' | 'setup' | 'check' | null

export interface PlatformRow {
  readonly platform: string
  readonly state: PlatformState
  readonly action: PlatformAction
  readonly readiness: Readiness
  readonly info: MachinePlatformInfo
}

/** Rows first in this order, then the rest as LayerFS listed them. */
const ORDER = ['native', 'docker', 'lima', 'apple-container']

const STATE: Record<Readiness['step'], PlatformState> = {
  ready: 'available', install: 'notInstalled', setup: 'needsSetup', start: 'notRunning', runtime: 'needsBundle', unsupported: 'needsSetup',
}
const ACTION: Record<Readiness['step'], PlatformAction> = {
  ready: null, install: 'install', setup: 'setup', start: 'check', runtime: null, unsupported: null,
}

/**
 * The Machines rows: every platform this computer can run, now or once
 * something is installed or started. A platform it can never run (Lima on
 * Linux, Apple Container on Intel) is left out. One that needs the Linux
 * bundle has no action here: the LayerFS section above shows that problem.
 */
export function platformRows(platforms: readonly MachinePlatformInfo[], os: HostOs, ctx: Pick<NeedContext, 'bundleDir'> = {}): PlatformRow[] {
  const rank = (p: string) => { const i = ORDER.indexOf(p); return i < 0 ? ORDER.length : i }
  return platforms
    .map((info, i) => ({ info, i, readiness: readinessOf(info, os, null, ctx) }))
    .filter((x) => x.readiness.step !== 'unsupported')
    .sort((a, b) => rank(a.info.platform) - rank(b.info.platform) || a.i - b.i)
    .map(({ info, readiness }) => ({
      platform: info.platform,
      state: readiness.step === 'ready' && info.platform === 'native' ? 'ready' : STATE[readiness.step],
      // not ready with nothing reported (LayerFS knows why): no empty how-to, Check alone
      action: readiness.step === 'setup' && readiness.fixes.length === 0 ? 'check' : ACTION[readiness.step],
      readiness,
      info,
    }))
}

/** How many rows can run now, of how many. */
export const canRun = (rows: readonly PlatformRow[]): { n: number, total: number } => ({ n: rows.filter((r) => r.state === 'ready' || r.state === 'available').length, total: rows.length })
