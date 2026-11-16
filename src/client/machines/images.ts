/**
 * The New Sandbox Image menu's rules, kept pure so they are unit-tested
 * (test/machines-images.test.mjs): which row is preselected (D7), what the
 * create button says and the note line under the menu, a row's one tag, and
 * a background create's phase in words (docs/specs/sandbox-images.md §5).
 */
import type { MachinesKey } from './locale.ts'
import { bytes, projectRef, type Creation, type DockerImage, type ImageLoad, type ImageReason, type MachineSandbox, type ReadyImage, type SandboxImagesView, type Words } from './model.ts'

const words = (key: MachinesKey, values?: Record<string, string>): Words => (values ? { key, values } : { key })

/** The row picked in the Image menu. The client always sends its `id` as the create's `image`. */
export interface ImagePick {
  id: string
  /** The ref it is named by ({@link displayRef}, display only); null for an image with none (the bundle's). */
  ref: string | null
  name: string
  from: 'ready' | 'docker'
  size: number | null
  usable: boolean
  /** The pinned bundle's image: named "LayerFS default" in this locale. */
  bundle: boolean
}

/** The ref an image is named by: the one ending `:latest` if it has one (what people pick), else its first. */
export const displayRef = (refs: readonly string[]): string | null => refs.find((r) => r.endsWith(':latest')) ?? refs[0] ?? null

/** A ready or Docker row as a pick. */
export function pickOf(row: ReadyImage | DockerImage, from: 'ready' | 'docker'): ImagePick {
  return { id: row.id, ref: displayRef(row.refs), name: row.name, from, size: row.size ?? null, usable: row.usable, bundle: 'source' in row && row.source === 'bundle' }
}

/** The row with this id, in the ready group first. */
export function findPick(answer: SandboxImagesView | null | undefined, id: string | null | undefined): ImagePick | null {
  if (!answer || !id) return null
  const ready = answer.ready.find((r) => r.id === id)
  if (ready) return pickOf(ready, 'ready')
  const docker = answer.docker?.available ? answer.docker.images.find((r) => r.id === id) : undefined
  return docker ? pickOf(docker, 'docker') : null
}

/**
 * The preselected row (D7): the usable ready image used last, else the
 * machine's default, else the first usable ready image. Never a Docker row.
 */
export function defaultPick(answer: SandboxImagesView | null | undefined): ImagePick | null {
  if (!answer || answer.mode === 'host') return null
  const usable = answer.ready.filter((r) => r.usable)
  const used = usable.filter((r) => r.lastUsed && Number.isFinite(Date.parse(r.lastUsed)))
    .sort((a, b) => Date.parse(b.lastUsed!) - Date.parse(a.lastUsed!))
  const row = used[0] ?? usable.find((r) => r.id === answer.default) ?? usable[0]
  return row ? pickOf(row, 'ready') : null
}

/** What the create button does: create, start the machine first, or free space first. */
export type PlanLabel = 'create' | 'start' | 'free'

/**
 * The button and the note line for a pick. One sentence shows, in this order:
 * no space, stopped, Docker off, the pick's own. `state` stands in for the
 * answer's while it is not read yet (the machine list's).
 */
export function imagePlan(answer: SandboxImagesView | null | undefined, pick: ImagePick | null, state?: string | null): { label: PlanLabel, note: Words | null } {
  const machine = answer?.machine ?? ''
  const stopped = (answer?.state ?? state) === 'stopped'
  if (answer?.mode === 'host') return { label: stopped ? 'start' : 'create', note: words('nativeOwnSystem') }
  const docker = pick?.from === 'docker' && answer?.docker?.available ? answer.docker.images.find((r) => r.id === pick.id) : undefined
  const noSpace = !!docker && !docker.fits && answer?.free != null
  const label: PlanLabel = stopped ? 'start' : noSpace ? 'free' : 'create'
  if (!answer) return { label, note: null }
  if (noSpace) return { label, note: words('noteNoSpace', { need: bytes(docker!.need), machine, free: bytes(answer.free) }) }
  if (stopped) return { label, note: words('noteStopped', { machine }) }
  if (answer.docker && !answer.docker.available) {
    return { label, note: words(answer.docker.reason === 'not-installed' ? 'noteDockerMissing' : 'noteDockerOff', { machine }) }
  }
  if (!pick) return { label, note: null }
  const image = pick.ref ?? pick.name
  if (pick.from === 'docker') return { label, note: words('noteCopy', { image, size: bytes(pick.size), machine }) }
  return { label, note: pick.bundle ? words('noteReadyDefault', { machine }) : words('noteReady', { image, machine }) }
}

/**
 * Where a machine's image list stands: `fresh` (read now), `stopped` (the
 * machine is off: kept rows), `outdated` (it runs, but its worker is of
 * another LayerFS build: restarting the worker fixes it) or `failed` (it
 * runs and the read failed otherwise). `state` stands in for the answer's.
 */
export type ImagesStatus = 'fresh' | 'stopped' | 'outdated' | 'failed'
export function imagesStatus(answer: Pick<SandboxImagesView, 'stale' | 'state'> | null | undefined, state?: string | null): ImagesStatus {
  if ((answer?.state ?? state) === 'stopped') return 'stopped'
  if (!answer?.stale) return 'fresh'
  return answer.stale.code === 'WorkerOutdated' ? 'outdated' : 'failed'
}

/**
 * The ready group's footer. A stopped machine's kept rows say "As of when
 * <machine> last ran"; a worker of another build says to restart it; rows
 * kept because the read failed otherwise (the machine not stopped) say so
 * with the reason. Fresh rows: none. `state` stands in for the answer's
 * (the machine list's).
 */
export function imagesFooter(answer: SandboxImagesView | null | undefined, state?: string | null): Words | null {
  if (!answer?.stale) return null
  const machine = answer.machine
  switch (imagesStatus(answer, state)) {
    case 'stopped': return words('imagesAsOf', { machine })
    case 'outdated': return words('imagesWorkerOutdated', { machine })
    default: return words('imagesReadFailed', { machine, message: answer.stale.message || answer.stale.code })
  }
}

/** An unusable row's reason as its tag ("amd64 only", "needs glibc", "can't unpack"). */
export function reasonWords(reason: ImageReason | undefined): Words {
  switch (reason?.kind) {
    case 'arch': return words('dockerOtherArch', { arch: reason.value ?? '' })
    // an image whose config names no OS (a broken or attestation-only manifest) would read " only"
    case 'os': return reason.value ? words('imageOnlyOs', { os: reason.value }) : words('imageNoOs')
    case 'no-glibc': return words('imageNeedsGlibc')
    default: return words('imageCannotUnpack')
  }
}

/**
 * A background create's phase in words: Creating, Starting machine, Copying
 * image (x of y once the copy reports bytes, the host keeping them through
 * the copy's steps), Unpacking image, Starting Sandbox; a failure's reason.
 */
export function phaseWords(c: Pick<Creation, 'phase' | 'done' | 'total' | 'error'> & { input?: Pick<Creation['input'], 'machine'> }): Words {
  switch (c.phase) {
    case 'machine': return words('phaseMachine')
    case 'inspect': case 'export': case 'send':
      return c.done != null && c.total ? words('phaseCopyOf', { done: bytes(c.done), total: bytes(c.total) }) : words('phaseCopy')
    case 'unpack': return words('phaseUnpack')
    // done: the row stays until the machines read shows the Sandbox; it is still starting, not "Creating" again
    case 'start': case 'done': return words('phaseSandbox')
    case 'failed': {
      const reason = failureWords(c.error, c.input?.machine ?? '')
      return reason ?? words('createFailedRow', { reason: c.error?.message ?? c.error?.code ?? '' })
    }
    default: return words('phaseCreating')
  }
}

/** The share of the copy (or of unpacking, when it reports bytes) done, for its bar; null without bytes. */
export function phaseShare(c: Pick<Creation, 'phase' | 'done' | 'total'>): number | null {
  const bar = c.phase === 'inspect' || c.phase === 'export' || c.phase === 'send' || c.phase === 'unpack'
  return bar && c.done != null && c.total ? Math.max(0, Math.min(1, c.done / c.total)) : null
}

/** A machine tab's Sandbox group: one project's Sandboxes, and the creates of Sandboxes for it. */
export interface SandboxGroup { project: string, rows: MachineSandbox[], creating: Creation[] }

/** The project a Sandbox or a create is grouped under: its project's name, '' for none recorded. */
export const groupOf = (project: string | null | undefined): string => (project ? projectRef(project).name : '')

/** The Store a create's row names (its `input.project` is `<store>/<project>`), as a real row names its own. */
export const creationStore = (c: Pick<Creation, 'input'>): string => projectRef(c.input.project).store ?? ''

/**
 * The background creates of Sandboxes on a machine, newest first: running,
 * and failed ones until dismissed. LayerFS records a Sandbox (state
 * `creating`) as soon as its create begins, before the image is copied, so
 * a create's row stays until the machines read shows its Sandbox past
 * `creating`; its row then stands for it.
 */
export function creatingOn(all: Readonly<Record<string, Creation>>, machine: string, sandboxes: readonly MachineSandbox[]): Creation[] {
  return Object.values(all)
    .filter((c) => c.input.machine === machine && (c.phase === 'failed' || !sandboxes.some((b) => b.name === c.input.name && b.state !== 'creating')))
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** The Sandbox rows to draw beside `creating`: without the `creating` records a running create's row stands for (its phase, copy progress). */
export function besideCreating<T extends Pick<MachineSandbox, 'name' | 'state'>>(rows: readonly T[], creating: readonly Pick<Creation, 'phase' | 'input'>[]): T[] {
  const covered = new Set(creating.filter((c) => c.phase !== 'failed').map((c) => c.input.name))
  return rows.filter((b) => !(b.state === 'creating' && covered.has(b.name)))
}

/**
 * The machine tab's Sandbox groups, one per project: the projects with
 * Sandboxes in their order, each with its creates on top; a project with
 * only creates gets its own group, those first (newest work on top).
 * `rows` are the Sandboxes that do not need you (they show above, ungrouped).
 */
export function sandboxGroups(rows: readonly MachineSandbox[], creating: readonly Creation[]): SandboxGroup[] {
  const groups = new Map<string, SandboxGroup>()
  const at = (project: string) => {
    let g = groups.get(project)
    if (!g) groups.set(project, g = { project, rows: [], creating: [] })
    return g
  }
  for (const b of rows) at(groupOf(b.project)).rows.push(b)
  for (const c of creating) at(groupOf(c.input.project)).creating.push(c)
  const all = [...groups.values()]
  return [...all.filter((g) => !g.rows.length), ...all.filter((g) => g.rows.length)]
}

/**
 * "just now", "{n} min ago", "{n} h ago", "{n} d ago": a ready row's last use
 * (the same buckets as the primitives' relativeTime up to days; kept here so
 * these rules stay pure and unit-tested).
 */
export function agoWords(at: string | null | undefined, now: number): Words | null {
  const ms = at ? Date.parse(at) : NaN
  if (!Number.isFinite(ms)) return null
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000)
  if (minutes < 1) return words('agoNow')
  if (minutes < 60) return words('agoMinutes', { n: String(minutes) })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return words('agoHours', { n: String(hours) })
  return words('agoDays', { n: String(Math.floor(hours / 24)) })
}

/** A Docker row's tag: "412 MB to copy · copies once" (Docker's size, not the unpacked size on the machine), or why it cannot run. */
export function dockerTag(row: Pick<DockerImage, 'usable' | 'reason' | 'size'>): Words {
  return row.usable ? words('imageCopiesOnce', { size: bytes(row.size) }) : reasonWords(row.reason)
}

/** Who uses a cached image: "Unused", "1 Sandbox", "{n} Sandboxes". */
export function usedByWords(n: number): Words {
  return n <= 0 ? words('imagesUnused') : n === 1 ? words('imagesUsedByOne') : words('imagesUsedBy', { n: String(n) })
}

/** The Images section's foot: the cached images' total size on the machine's disk, and its free space when known. */
export function imagesTotal(answer: Pick<SandboxImagesView, 'machine' | 'free' | 'ready'>): Words {
  const total = answer.ready.reduce((sum, r) => sum + (r.size ?? 0), 0)
  return answer.free != null
    ? words('imagesTotal', { total: bytes(total), machine: answer.machine, free: bytes(answer.free) })
    : words('imagesTotalOnly', { total: bytes(total), machine: answer.machine })
}

/** A cached image the Images section and Free space can remove: not the bundle's (LayerFS keeps its default), and the machine answers. */
export const removable = (row: Pick<ReadyImage, 'source'>): boolean => row.source !== 'bundle'

/** Free space's rows: the removable images, the unused ones preselected. */
export function freeSpaceRows(answer: Pick<SandboxImagesView, 'ready'> | null | undefined): { rows: ReadyImage[], preselected: string[] } {
  const rows = (answer?.ready ?? []).filter(removable)
  return { rows, preselected: rows.filter((r) => r.sandboxes <= 0).map((r) => r.id) }
}

/** Free space's footer: the bytes the checked images free, and what the new Sandbox needs when it was opened from New Sandbox. */
export function freesWords(rows: readonly Pick<ReadyImage, 'id' | 'size'>[], checked: readonly string[], need?: number | null): Words {
  const size = bytes(rows.filter((r) => checked.includes(r.id)).reduce((sum, r) => sum + (r.size ?? 0), 0))
  return need != null ? words('freesSizeNeed', { size, need: bytes(need) }) : words('freesSize', { size })
}

/**
 * A failed create's reason in this locale (§4.4), by its refusal code and
 * detail, as the whole row ("Couldn't create: …"); null for a refusal with
 * no words of its own (the row keeps LayerFS's message).
 */
export function failureWords(error: Creation['error'] | null | undefined, machine: string): Words | null {
  const d = (error?.detail && typeof error.detail === 'object' ? error.detail : {}) as Record<string, unknown>
  const message = error?.message || ''
  switch (error?.code) {
    case 'NoSpace':
      return typeof d.need === 'number' && typeof d.free === 'number' ? words('imageNoSpace', { machine, need: bytes(d.need), free: bytes(d.free) }) : null
    case 'Unsupported':
      if (d.reason === 'arch') return words('imageWrongArch', { arch: String(d.value ?? '') })
      if (d.reason === 'host') return words('imageHostOnly')
      if (d.need === 'image-refs') return words('imageNeedsNewerLayerfs')
      break
    case 'Unavailable':
      return d.what === 'docker' ? words('dockerNotRunning') : words('machineStopped', { machine })
    case 'InvalidInput':
      if (/image/i.test(message)) return words('imageUnknown')
      break
    case 'Busy': return words('machineBusy', { machine })
    case 'Exists': case 'NameTaken': return words('sandboxNameTaken')
    case 'Timeout': return words('imageTimeout')
  }
  return null
}

/** A failure Free space can fix (its Retry reads "Free space"). */
export const needsSpace = (c: Pick<Creation, 'phase' | 'error'>): boolean => c.phase === 'failed' && c.error?.code === 'NoSpace'

/**
 * The Images tab's Docker section: the images of this computer's Docker not
 * on the machine yet (LayerFS lists them already without the stored ones),
 * the ones that can run first, each group in LayerFS's order, narrowed by a
 * case-blind match on any ref. `fits` false still lists the image: the copy
 * is LayerFS's to refuse (NoSpace).
 */
export function dockerRows(answer: SandboxImagesView | null | undefined, query = ''): { usable: DockerImage[], unusable: DockerImage[], total: number } {
  const all = answer?.docker?.available ? answer.docker.images : []
  const q = query.trim().toLowerCase()
  const shown = q ? all.filter((r) => r.name.toLowerCase().includes(q) || r.refs.some((ref) => ref.toLowerCase().includes(q))) : all
  return { usable: shown.filter((r) => r.usable), unusable: shown.filter((r) => !r.usable), total: all.length }
}

/** An image's name in parts: the registry and path before the repository (shown quieter), the repository, and its tags. */
export interface ImageLabel { registry: string, repo: string, tags: string[] }

const parseRef = (ref: string): { registry: string, repo: string, tag: string } => {
  const slash = ref.lastIndexOf('/')
  const colon = ref.lastIndexOf(':')
  const path = colon > slash ? ref.slice(0, colon) : ref
  const tag = colon > slash ? ref.slice(colon + 1) : ''
  const cut = path.lastIndexOf('/')
  return { registry: cut >= 0 ? path.slice(0, cut + 1) : '', repo: cut >= 0 ? path.slice(cut + 1) : path, tag }
}

/**
 * `cgr.dev/chainguard/minio:latest` as `{ registry: 'cgr.dev/chainguard/', repo: 'minio', tags: ['latest'] }`:
 * the repository of `name` (the ref the row is named by), and every tag the
 * image carries in that repository, the name's own first. One image only:
 * two tags that are different images stay two rows.
 */
export function imageLabel(name: string, refs: readonly string[]): ImageLabel {
  const own = parseRef(name)
  const tags = [own.tag, ...refs.map(parseRef).filter((p) => p.registry === own.registry && p.repo === own.repo).map((p) => p.tag)].filter(Boolean)
  return { registry: own.registry, repo: own.repo, tags: [...new Set(tags)] }
}

/** A repository's badge colour, 0–5, the same every time for the same name. */
export function badgeHue(repo: string): number {
  let h = 0
  for (const ch of repo) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 6
}

/** The Images tab's disk bar: one segment per stored image, then everything else used, then free; null without the disk's total. */
export function diskSegments(ready: readonly Pick<ReadyImage, 'id' | 'size'>[], total: number | null, free: number | null): { images: { id: string, bytes: number, share: number }[], imagesBytes: number, rest: number, free: number, total: number } | null {
  if (total == null || free == null || !(total > 0)) return null
  const images = ready.map((r) => ({ id: r.id, bytes: Math.max(0, r.size ?? 0), share: Math.max(0, r.size ?? 0) / total }))
  const imagesBytes = images.reduce((sum, r) => sum + r.bytes, 0)
  return { images, imagesBytes, rest: Math.max(0, total - free - imagesBytes), free: Math.max(0, free), total }
}

/** A copy's row text: waiting, the copy's bytes, unpacking, or why it failed. */
export function loadWords(load: Pick<ImageLoad, 'phase' | 'done' | 'total' | 'error' | 'machine'>): Words {
  switch (load.phase) {
    case 'queued': return words('imgCopyQueued')
    case 'failed': return failureWords(load.error, load.machine) ?? words('imgCopyFailed', { reason: load.error?.message ?? load.error?.code ?? '' })
    case 'done': return words('imgCopyDone')
    default: return phaseWords({ phase: load.phase, done: load.done, total: load.total })
  }
}
