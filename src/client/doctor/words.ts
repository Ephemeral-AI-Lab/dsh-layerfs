/**
 * The Doctor page's words: every sentence a row, a tip or a toast shows, made
 * from the model's codes and the locale. LayerFS's own words (check ids,
 * messages, fix lines, refusal sentences) are shown as they came.
 */
import { doctorCommand, shortDigest } from '../../shared/doctor.ts'
import { locales, type DoctorT } from './locale.ts'
import { busyOn, callOf, humanCheck, isAllGroup, kidsOf, type DoctorState, type Mark as CheckMark, type Off, type RowFix, type RowState, type RowView, type TabView, type Thing } from './model.ts'
import type { MarkKind, TipCheck, TipData } from './tips.tsx'
import type { Say } from './use-doctor.ts'

type Loose = (key: string, params?: Record<string, string | number>) => string

export const DOT: Record<RowState, MarkKind> = { ok: 'ok', run: 'run', nc: 'nc', notice: 'warn', problem: 'bad' }
const WORD: Record<RowState, string> = { ok: 'dpWordOk', run: 'dpWordRun', nc: 'dpWordNc', notice: 'dpWordNotice', problem: 'dpWordProblem' }
const RES: Record<CheckMark['r'], string> = { ok: 'dpResOk', bad: 'dpResBad', warn: 'dpResWarn', nc: 'dpResNc' }
const FIX: Record<NonNullable<RowFix['button']>, string> = { start: 'dpFixStart', restart: 'dpFixRestart', delete: 'dpFixDelete', backup: 'dpFixBackup' }
const STEP = new Map<string, string>([
  ['stop', 'dpStepStop'],
  ['start', 'dpStepStart'],
  ['delete', 'dpStepDelete'],
  ['create', 'dpStepCreate'],
])
const REASON_SHORT = new Map<string, string>([
  ['timeout', 'dpShortTimeout'],
  ['busy', 'dpShortBusy'],
  ['lost', 'dpShortLost'],
  ['failed', 'dpShortFailed'],
  ['stopped', 'dpShortStopped'],
  ['skipped', 'dpShortSkipped'],
  ['unavailable', 'dpShortUnavailable'],
  ['missing', 'dpShortMissing'],
  ['unsupported', 'dpShortUnsupported'],
  ['outdated', 'dpShortOutdated'],
  ['corrupt', 'dpShortCorrupt'],
  ['unreachable', 'dpShortUnreachable'],
  ['unresolved', 'dpShortUnresolved'],
  ['not_answering', 'dpShortNotAnswering'],
])
const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

export const clock = (at: number): string => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
export const mmss = (ms: number): string => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
/** A code as words (`not_answering` -> `Not answering`). */
const human = (code: string): string => cap(code.replace(/[_.-]+/g, ' ').trim())

export type Words = ReturnType<typeof wordsOf>

export function wordsOf(t: DoctorT) {
  const tt = t as unknown as Loose
  const n = (key: string, count: number): string => (count === 1 ? tt(`${key}One`) : tt(key, { n: count }))
  const word = (st: RowState): string => tt(WORD[st])
  /** Displayed & announced status word for a row (`Stopped` / `Partial` override raw `ok` / `nc`). */
  const rowStatus = (v: RowView): string => {
    const o = v.seen
    if (o.stopped && (o.st === 'ok' || o.st === 'nc')) return tt('dpWordStopped')
    if (o.st === 'nc' && o.why === 'partial') return tt('dpWordPartial')
    return word(o.st)
  }
  /** A finding's own word: the locale's for its check id, else the id's last part spelled out. */
  const checkWord = (id: string): string => { const key = `chk_${id.replace(/[^A-Za-z0-9]/g, '_')}`; return Object.hasOwn(locales.en, key) ? tt(key) : humanCheck(id) }
  const rowWord = (code: string | null): string => {
    if (!code) return ''
    if (code === 'stopped') return tt('dpWordStopped')
    if (code === 'could') return tt('dpWordCould')
    if (code.startsWith('check:')) return checkWord(code.slice(6))
    const raw = code.slice(code.indexOf(':') + 1)
    const key = REASON_SHORT.get(raw.toLowerCase())
    return key ? cap(tt(key)) : human(raw)
  }
  const nameOf = (x: Thing): string => (x.kind === 'home' ? tt('dpHomeName', { version: x.version ?? '' }).trim() : x.kind === 'machine' && x.name === 'native' ? tt('dpHomeMachine') : x.name)
  const platform = (p: string | null | undefined): string => (p === 'native' ? tt('dpThisComputer') : p ?? '')
  const engine = (e: string | null | undefined): string => (e === 'postgresql' ? 'PostgreSQL' : 'SQLite')
  const provider = (p: string | null | undefined): string => (p === 'r2' ? 'Cloudflare R2' : p === 'minio' ? 'MinIO' : p === 's3' ? 'S3' : p ?? '')
  const kind = (x: Thing): string => (x.kind === 'home' ? tt('dpKindHome') : x.kind === 'machine' ? tt('dpKindMachine', { platform: platform(x.platform) })
    : x.kind === 'store' ? tt('dpKindStore', { engine: engine(x.engine) }) : x.kind === 'project' ? tt('dpKindProject') : x.kind === 'sandbox' ? tt('dpKindSandbox')
      : x.kind === 'workspace' ? tt('dpKindWorkspace') : tt('dpKindBucket', { provider: provider(x.provider) }))
  /** The call that checks a thing: its own doctor; a Workspace's is its Sandbox's. */
  const callFor = (x: Thing, full = false): string => (x.kind === 'workspace' ? doctorCommand({ kind: 'sandbox', name: x.sandbox ?? '' }) : doctorCommand(callOf(x, full)))
  const checkName = (c: CheckMark): string => (c.from ? tt('dpCheckFrom', { check: c.check, machine: c.from }) : c.check)
  const checkText = (c: CheckMark): string => {
    const code = c.reason?.toLowerCase() ?? ''
    const short = REASON_SHORT.get(code)
    const note = c.r === 'nc' ? (c.reason ? (short ? tt(short) : human(c.reason).toLowerCase()) : '') : c.message ?? ''
    return note ? tt('dpResNote', { result: tt(RES[c.r]), note }) : tt(RES[c.r])
  }
  const tipChecks = (checks: readonly CheckMark[]): TipCheck[] => checks.map((c) => ({ r: c.r, name: checkName(c), text: checkText(c) }))
  const fixLabel = (fix: RowFix | null): string => (fix?.button ? tt(FIX[fix.button]) : '')
  const stepWord = (step: string | null | undefined): string => { const key = step ? STEP.get(step) : undefined; return key ? tt(key) : '' }
  const offText = (off: Off | null): string | null => (!off ? null : off.why === 'all' ? tt('dpOffAll') : off.why === 'fix' ? tt('dpOffFix') : off.why === 'busy' ? tt('dpOffBusy')
    : off.n === 0 ? tt('dpOffForced') : n('dpOffSandboxes', off.n))
  const inside = (v: RowView): string => {
    const what = [v.inside.bad ? n('dpProblems', v.inside.bad) : '', v.inside.warn ? n('dpNotices', v.inside.warn) : ''].filter(Boolean).join(' · ')
    return what ? tt('dpInside', { what }) : ''
  }

  /** What a row says after its signal: facts from its tree node only. */
  const fact = (state: DoctorState, v: RowView): string => {
    const x = v.thing
    const world = state.world!
    const on = v.depth === 0 && x.machine && world.by[x.machine] ? tt('dpFactOn', { machine: world.by[x.machine]!.name }) : ''
    const note = state.notes[x.key]
    const kids = kidsOf(world, x)
    const bits: string[] = []
    if (x.kind === 'home') bits.push(x.name)
    else if (x.kind === 'machine') {
      bits.push(platform(x.platform))
      if (x.cpus) bits.push(tt('dpFactCpu', { n: x.cpus }))
      if (x.memoryBytes) bits.push(tt('dpFactMemory', { n: Math.round(x.memoryBytes / 1024 ** 3) }))
      const stores = kids.filter((k) => k.kind === 'store').length, boxes = kids.filter((k) => k.kind === 'sandbox').length
      if (stores) bits.push(n('dpFactStores', stores))
      if (boxes) bits.push(n('dpFactSandboxes', boxes))
    } else if (x.kind === 'store') {
      bits.push(x.engine ?? '')
      bits.push(n('dpFactProjects', kids.length), on)
    } else if (x.kind === 'sandbox') {
      // a 64-hex image id cut to its first twelve digits (the row's tip has it whole)
      bits.push(x.project ?? '', shortDigest(x.image))
      if (!x.notListed || kids.length) bits.push(n('dpFactWorkspaces', kids.length))
      bits.push(on)
    } else if (x.kind === 'workspace') {
      if (x.branch) bits.push(tt('dpFactBranch', { branch: x.branch }))
    } else if (x.kind === 'project') {
      // a row that reads Not checked again (a fix, a changed record) says no older data read beside it
      if (note?.fullAt && v.seen.st !== 'nc') bits.push(tt('dpFactDataRead', { time: clock(note.fullAt) }))
    } else {
      bits.push(provider(x.provider))
      if (note?.fullAt && v.seen.st !== 'nc') bits.push(tt('dpFactWriteTested', { time: clock(note.fullAt) }))
    }
    return bits.filter(Boolean).join(' · ')
  }

  /** The tip of a row's signal: the state in words, LayerFS's reason, and the fix to copy. */
  const sigTip = (state: DoctorState, v: RowView): TipData => {
    const x = v.thing, o = v.seen, r = o.r
    const fixCmds = v.fix ? [`# ${tt('dpCmdFix')}`, v.fix.line] : []
    const nc = word('nc')
    if (o.st === 'run') {
      const run = busyOn(state, x.key)
      if (!run || isAllGroup(run.group)) return { title: word('run'), lines: run ? [tt('dpOffAll')] : [] }
      const target = state.world!.by[run.target]
      return { title: word('run'), cmds: [target ? callFor(target, run.kind === 'full') : callFor(x)] }
    }
    if (o.st === 'ok') {
      const note = state.notes[x.key]
      const lines = [r ? tt('dpTipChecked', { time: clock(r.at) }) : '']
      if (x.kind === 'project') lines.push(note?.fullAt ? tt('dpTipDataRead', { time: clock(note.fullAt) }) : tt('dpTipDataNever'))
      if (x.kind === 'bucket') lines.push(note?.fullAt ? tt('dpTipWriteTested', { time: clock(note.fullAt) }) : tt('dpTipWriteNever'))
      if (note?.stopped != null) lines.push(tt('dpTipFullStopped', { elapsed: mmss(note.stopped) }))
      // a machine stopped on purpose whose own checks pass
      if (o.stopped) return { title: tt('dpTipStoppedStaticTitle'), lines: [...lines, tt('dpTipStoppedSelf')], cmds: fixCmds }
      return { title: word('ok'), lines }
    }
    if (o.st === 'notice' || o.st === 'problem') {
      const own = rowWord(v.word)
      return { title: own ? `${word(o.st)} · ${own}` : word(o.st), mark: DOT[o.st], lines: [o.message ?? ''], cmds: fixCmds }
    }
    if (o.why === 'stopped-self') return { title: `${nc} · ${tt('dpWordStopped')}`, lines: [tt('dpTipStoppedSelf')], cmds: fixCmds }
    if (o.why === 'stopped') return { title: nc, lines: [tt('dpTipStopped')] }
    if (o.why === 'waiting') return { title: nc, lines: [tt('dpTipWaiting', { name: o.by ? nameOf(o.by) : o.byName ?? '' })] }
    if (o.why === 'could') return { title: tt('dpWordCould'), lines: [tt(`dpReason${cap(o.reason ?? 'lost')}`), tt('dpTipAgain')], cmds: [callFor(x)] }
    if (o.why === 'parent') return { title: nc, lines: [tt('dpTipParent', { name: o.by ? nameOf(o.by) : '' })] }
    if (o.why === 'partial') return { title: tt('dpWordPartial'), lines: [tt('dpTipPartial')] }
    if (o.why === 'working') return { title: nc, lines: [tt('dpTipWorking', { op: x.op?.name ?? '' })] }
    if (o.why === 'unknown') return { title: nc, lines: [tt('dpTipUnknown')] }
    return { title: nc, lines: [tt(x.kind === 'workspace' ? 'dpTipNeverWorkspace' : 'dpTipNever')] }
  }

  /** What a screen reader gets for a row beside its name. */
  const said = (v: RowView, phase: string): string => {
    const waits = v.seen.st === 'nc' && v.seen.why === 'waiting' ? (v.seen.by ? nameOf(v.seen.by) : v.seen.byName) : null
    const stoppedNeutral = v.seen.stopped && (v.seen.st === 'ok' || v.seen.st === 'nc')
    return [kind(v.thing), rowStatus(v), stoppedNeutral ? '' : rowWord(v.word), phase, waits ? tt('dpWaitingOn', { name: waits }) : '', inside(v)].filter(Boolean).join(', ')
  }

  const tabSaid = (tab: TabView): string[] => [
    tab.bad ? n('dpProblems', tab.bad) : '', tab.running ? tt('dpTabChecking', { n: tab.running }) : '', tab.warn ? n('dpNotices', tab.warn) : '',
    tab.stopped ? tt('dpTabStopped', { n: tab.stopped }) : '', tab.could ? tt('dpTabCould', { n: tab.could }) : '',
  ].filter(Boolean)

  const toast = (what: Say): string => {
    const fix = 'fix' in what && what.fix ? tt(FIX[what.fix]) : ''
    switch (what.kind) {
      case 'allDone': return tt('dpToastAllDone')
      case 'could': return tt('dpToastCould', { name: what.name, reason: tt(`dpShort${cap(what.reason)}`) })
      case 'fullStopped': return tt('dpToastFullStopped', { name: what.name })
      case 'dataRead': return tt('dpToastDataRead', { name: what.name })
      case 'writeTested': return tt('dpToastWriteTested', { name: what.name })
      case 'ready': return tt('dpToastReady', { name: what.name })
      case 'deleted': return tt('dpToastDeleted', { name: what.name })
      case 'backedUp': return tt('dpToastBackedUp', { name: what.name })
      case 'refused': return tt('dpToastRefused', { name: what.name, fix })
      case 'lost': return tt('dpToastLost', { name: what.name, fix })
      default: return tt('dpToastNotStarted', { message: what.message })
    }
  }

  return { t: tt, n, word, rowStatus, rowWord, nameOf, kind, callFor, checkName, checkText, tipChecks, fixLabel, stepWord, offText, inside, fact, sigTip, said, tabSaid, toast }
}
