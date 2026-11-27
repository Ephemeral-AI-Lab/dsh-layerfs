/**
 * What a platform needs before it can run here, as one ladder. LayerFS's
 * home get --with platforms reports each platform's `missing` needs (`tool:<cli>`,
 * `host:<fact>`, `bundle:<…>`); this sorts each need into the step that
 * fixes it and says how, for this computer's OS:
 *
 *   unsupported  this computer can never run it (needs a Mac, Apple silicon…): folded away, no action
 *   install      a command is not installed: what to install, commands to copy
 *   setup        the host lacks something it can have (root, /dev/fuse, cgroup v2, WSL2)
 *   start        installed but not running (the Docker Engine does not answer)
 *   runtime      LayerFS's own Linux bundle is missing: the Set up LayerFS modal fixes it
 *   ready        nothing missing
 *
 * A platform's step is its first need's step in that order, so a Lima row on
 * Linux (`host:macos`, `tool:limactl`) is unsupported, not "install Lima".
 * The same answer serves the Add a machine dialog, the machine blocks of an
 * existing machine whose platform stopped being ready, and nothing else
 * guesses: needs this table does not know are shown in LayerFS's words.
 */
import type { MachinesKey } from './locale.ts'
import type { AvailableView, Computer, DockerSocket, MachineInfo, MachinePlatformInfo, Words } from './model.ts'

export type HostOs = Computer['os']
export type Step = 'unsupported' | 'install' | 'setup' | 'start' | 'runtime' | 'ready'

/** One need's fix: words, then commands to copy (a URL is shown as a link). */
export interface Fix {
  need: string, step: Step, why: Words, how: Words | null, commands: string[]
  /** The Set up LayerFS modal fixes it (a missing Linux bundle): its section, opened by "Fix in setup". */
  setup?: 'runtime'
  /** Docker's socket does not answer and LayerFS offers other sockets: docker's Settings can choose one. */
  socket?: true
}

/** What else the ladder reads: docker's socket (home get --with platforms) and the bundle folder LayerFS resolved (setup.status). */
export interface NeedContext {
  /** docker's socket as LayerFS reports it; `denied` gets the docker group fix instead of Start. */
  socket?: DockerSocket | null | undefined
  /** Whether LayerFS listed other sockets (`candidates`): the socket fix links to docker's Settings. */
  candidates?: boolean | undefined
  /** The Linux bundle folder LayerFS resolved (`setup.status` `pieces.bundle.path`), when the need names none. */
  bundleDir?: string | null | undefined
}

export interface Readiness { step: Step, fixes: Fix[] }

/** Steps from the hardest to the easiest; a platform shows its hardest. */
export const STEPS: readonly Step[] = ['unsupported', 'install', 'setup', 'start', 'runtime', 'ready']

const w = (key: MachinesKey, values?: Record<string, string>): Words => (values ? { key, values } : { key })

/** Host facts no install fixes: this computer cannot run the platform. */
const NEVER: Record<string, MachinesKey> = {
  'host:macos': 'needMacos',
  'host:macos15': 'needMacos15',
  'host:apple-silicon': 'needAppleSilicon',
  'host:apple-m3': 'needAppleM3',
  'host:macos-or-linux': 'needMacosOrLinux',
  'host:wsl2-worker': 'needWsl2Worker',
}

/** What a tool is called and how to install it, per OS (none: LayerFS runs it on no other OS). */
const TOOLS: Record<string, { name: string, how: Partial<Record<HostOs, { words: MachinesKey, commands: string[] }>> }> = {
  limactl: { name: 'Lima', how: { macos: { words: 'installLima', commands: ['brew install lima'] } } },
  container: { name: 'Apple container', how: { macos: { words: 'installContainer', commands: ['https://github.com/apple/container/releases', 'container system start'] } } },
  msb: {
    name: 'msb',
    how: {
      macos: { words: 'installMsb', commands: ['curl -fsSL https://install.microsandbox.dev | sh'] },
      linux: { words: 'installMsb', commands: ['curl -fsSL https://install.microsandbox.dev | sh'] },
    },
  },
  docker: {
    name: 'Docker',
    how: {
      macos: { words: 'installDockerEngine', commands: ['brew install --cask docker', 'https://docs.docker.com/desktop/setup/install/mac-install/'] },
      linux: { words: 'installDockerLinux', commands: ['https://docs.docker.com/engine/install/', 'sudo systemctl enable --now docker'] },
      windows: { words: 'installDockerWindows', commands: ['https://docs.docker.com/desktop/setup/install/windows-install/'] },
    },
  },
}

/** A host fact this computer can have: how to set it up. */
const SETUP: Record<string, { why: MachinesKey, how: MachinesKey, commands: string[] }> = {
  'host:root': { why: 'needRoot', how: 'fixRoot', commands: [] },
  'host:/dev/fuse': { why: 'needFuse', how: 'fixFuse', commands: ['sudo modprobe fuse'] },
  'host:cgroup2': { why: 'needCgroup2', how: 'fixCgroup2', commands: ['stat -fc %T /sys/fs/cgroup'] },
  'host:wsl2': { why: 'needWsl2', how: 'fixWsl2', commands: ['wsl --install'] },
}

/** One need's step and fix on `os`. */
export function fixOf(need: string, platform: string, os: HostOs, _layerfs: string | null = null, ctx: NeedContext = {}): Fix {
  if (NEVER[need]) return { need, step: 'unsupported', why: w(NEVER[need]), how: null, commands: [] }
  if (need.startsWith('tool:')) {
    const tool = need.slice(5)
    const known = TOOLS[tool]
    const how = known?.how[os]
    if (known && !how) return { need, step: 'unsupported', why: w('needToolOs', { tool: known.name }), how: null, commands: [] }
    return { need, step: 'install', why: w('needTool', { tool: known?.name ?? tool }), how: how ? w(how.words) : w('installTool', { tool }), commands: how?.commands ?? [] }
  }
  // Docker's `host:<socket>`: the Engine is installed but does not answer there; starting it fixes it.
  if (platform === 'docker' && need.startsWith('host:/') && need !== 'host:/dev/fuse') {
    const socket = need.slice(5)
    const choose = ctx.candidates ? { socket: true as const } : {}
    // the socket is there but this user may not open it: the docker group, not Start
    if (ctx.socket?.state === 'denied') {
      return {
        need, step: 'setup', why: w('needDockerDenied', { socket: ctx.socket.path ?? socket }),
        how: w(os === 'linux' ? 'fixDockerGroup' : 'fixDockerDenied'),
        commands: os === 'linux' ? ['sudo usermod -aG docker $USER'] : [],
        ...choose,
      }
    }
    return {
      need, step: 'start', why: w('needDockerSocket', { socket }),
      how: w(os === 'linux' ? 'fixDockerStartLinux' : 'installDockerStart'),
      commands: os === 'linux' ? ['sudo systemctl start docker'] : os === 'macos' ? ['open -a Docker', 'colima start'] : [],
      ...choose,
    }
  }
  if (SETUP[need]) { const s = SETUP[need]; return { need, step: 'setup', why: w(s.why), how: w(s.how), commands: s.commands } }
  // LayerFS's Linux bundle: `bundle:<dir>` names where LayerFS looks; the setup modal picks a runtime that has one
  if (need.startsWith('bundle:')) {
    const named = need.slice(7)
    const folder = named.startsWith('/') || named.startsWith('~') ? named : ctx.bundleDir || null
    return {
      need, step: 'runtime', why: w('needBundle'),
      how: folder ? w('fixBundleIn', { folder }) : w('fixBundle'),
      commands: [], setup: 'runtime',
    }
  }
  // a host fact this table does not know: shown in LayerFS's words, and kept in view (it may be fixable)
  if (need.startsWith('host:')) return { need, step: 'setup', why: w('needHost', { thing: need.slice(5) }), how: null, commands: [] }
  return { need, step: 'setup', why: w('raw', { text: need }), how: null, commands: [] }
}

/** A platform's readiness on `os`: its hardest step and every need's fix, hardest first. */
export function readinessOf(p: Pick<MachinePlatformInfo, 'platform' | 'ready' | 'missing' | 'socket' | 'candidates'>, os: HostOs, _layerfs: string | null = null, ctx: Pick<NeedContext, 'bundleDir'> = {}): Readiness {
  if (p.ready && p.missing.length === 0) return { step: 'ready', fixes: [] }
  // within a step LayerFS's host facts come first: "Needs macOS" says more than "LayerFS runs Lima only on macOS"
  const host = (f: Fix) => (f.need.startsWith('host:') ? 0 : 1)
  const need: NeedContext = { ...ctx, socket: p.socket ?? null, candidates: (p.candidates?.length ?? 0) > 0 }
  const fixes = p.missing.map((n) => fixOf(n, p.platform, os, null, need)).sort((a, b) => STEPS.indexOf(a.step) - STEPS.indexOf(b.step) || host(a) - host(b))
  // not ready yet nothing reported missing: LayerFS knows why; treat it as something to set up
  return { step: fixes[0]?.step ?? (p.ready ? 'ready' : 'setup'), fixes }
}

/** The machine's platform row when it is not ready here: the machine cannot run until it is fixed. */
export function blockOf(platforms: readonly Pick<MachinePlatformInfo, 'platform' | 'ready' | 'missing' | 'socket' | 'candidates'>[], platform: string, os: HostOs, layerfs: string | null = null, ctx: Pick<NeedContext, 'bundleDir'> = {}): Readiness | null {
  const p = platforms.find((x) => x.platform === platform)
  if (!p) return null
  const r = readinessOf(p, os, layerfs, ctx)
  return r.step === 'ready' ? null : r
}

/** What keeps machine `m` from running here: its platform's readiness when not ready (Docker quit, Lima removed). */
export function machineBlock(m: Pick<MachineInfo, 'platform'>, view: { platforms: readonly Pick<MachinePlatformInfo, 'platform' | 'ready' | 'missing' | 'socket' | 'candidates'>[], computer?: Computer | undefined }, ctx: Pick<NeedContext, 'bundleDir'> = {}): Readiness | null {
  return blockOf(view.platforms, m.platform, osOfView(view), null, ctx)
}

/**
 * Whether Start clears `block` by itself: a docker machine on macOS whose
 * every need is the Docker Engine not answering (the `start` step). The host
 * launches Docker Desktop, OrbStack or colima first, then starts the machine
 * (host docker-engine.ts); anything else keeps Start hidden.
 */
export function engineStart(m: Pick<MachineInfo, 'platform'>, block: Readiness | null, os: HostOs): boolean {
  return !!block && m.platform === 'docker' && os === 'macos' && block.fixes.length > 0 && block.fixes.every((f) => f.step === 'start')
}

/** The reasons of a readiness's own step, joined (its hardest needs). */
export const stepReasons = (r: Readiness, tw: (words: Words) => string): string => r.fixes.filter((f) => f.step === r.step).map((f) => tw(f.why)).join(' · ')

/** The version a tool reports, short: `container CLI version 1.6.1 (build: …)` -> `1.6.1`. */
export function shortVersion(version: string | null | undefined): string | null {
  if (!version) return null
  return /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(version)?.[0] ?? version
}

/** This computer's OS, `macos` when an older host did not say. */
export const osOfView = (view: { computer?: Computer | undefined }): HostOs => view.computer?.os ?? 'macos'

/** The host machine's mark for this OS. */
export const hostGlyphOs = (os: HostOs): 'mac' | 'linux' | 'pc' => (os === 'macos' ? 'mac' : os === 'linux' ? 'linux' : 'pc')

/** The host machine's name on this OS: This Mac, This computer, This PC. */
export const hostNameKey = (os: HostOs): MachinesKey => (os === 'macos' ? 'hostMac' : os === 'windows' ? 'hostPc' : 'hostComputer')

/** The step's button and its tag. */
export const STEP_WORDS: Record<Exclude<Step, 'ready' | 'unsupported'>, { button: MachinesKey, tag: MachinesKey }> = {
  install: { button: 'stepInstall', tag: 'tagInstall' },
  setup: { button: 'stepSetup', tag: 'tagSetup' },
  start: { button: 'stepStart', tag: 'tagStart' },
  runtime: { button: 'fixInSetup', tag: 'tagRuntime' },
}

/** The setup modal's section a readiness's own step opens directly (a missing Linux bundle), or null. */
export const setupOf = (r: Readiness): 'runtime' | null => (r.step === 'runtime' ? r.fixes.find((f) => f.step === 'runtime')?.setup ?? null : null)
