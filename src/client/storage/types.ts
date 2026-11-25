/**
 * The Storage routes' bodies (LayerFS Connect's `host-api.ts`; the dsh-layerfs
 * host answers the same shapes).
 */
import type { BranchInfo, CommitInfo } from '../files/types.ts'

export interface SdkOperation { id: string, name: string, phase: string, started: number | null, uncertain: boolean }
/** A refusal as the host answers it; `fix` is LayerFS's one runnable line, when it gave one. */
export interface SdkRefusal { code: string, message: string, detail?: any, fix?: string }

export type StoreFamily = 'sqlite' | 'postgresql'

/** One Store's link to a bucket (2.0 `backups` rows): its last transfer that worked, and one that did not. */
export interface StoreBackupLink {
  bucket: string
  file: string
  last: { op: string, at: number | null, bytes: number | null } | null
  attempt?: { op: string, at: number | null, error: unknown } | null
}

/**
 * A PostgreSQL Store's saved connection (`store get`): the host is the one
 * place its address and login are saved. Never a password.
 */
export interface PgServer {
  /** The address (no user or password), `user@host:port/db` as `target`. */
  url: string | null
  target: string | null
  /** The server as `host:port` (host in lower case, port 5432 by default). */
  server: string | null
  database: string | null
  /** The saved user; null when LayerFS gave none. */
  user: string | null
  /** Whether a password is saved; null when the Store's record could not be read. */
  passwordSaved: boolean | null
  passwordChangedAt: number | null
  /** The Store's synchronous_commit, or null (LayerFS's default). */
  synchronousCommit: string | null
  /** The Store's id in its database (`store get` `id`). */
  binding?: string | null
  /** The host's last check of the database; null when none was recorded. */
  host?: PgReach | null
}

/** The last reach LayerFS saw from one side (`reach`, `machines[].reach`). */
export interface PgReach { at: number | null, ok: boolean, latencyMs: number | null, version: string | null, error: string | null }

/** One machine attached to a PostgreSQL Store (`store attach`): its Sandboxes may run there; it inherits the Store's address and login. */
export interface PgAttached {
  machine: string
  /** The last reach's word: `ok`, `failed`, or null when none was seen. */
  reached: 'ok' | 'failed' | null
  reach: PgReach | null
}

/** A 2.0 thing's state companions. */
export interface StateCompanions {
  blockedBy?: { machine?: string, reason: string }
  reason?: string
  fix?: string
  message?: string
  observedAt?: number
}

/** One Store: a `store list --detail --with stats` item, in LayerFS 2.0's six states. */
export interface StoreRow extends StateCompanions {
  name: string
  kind: StoreFamily
  machine: string | null
  /** The first 20 project names; `projectsCount` is all of them. */
  projects: string[]
  projectsCount?: number
  created: number | null
  /** The file with its write-ahead log; `stale` with `seen` when the machine did not answer and this is the last size read. */
  size: { bytes: number, seen?: number, stale?: true } | null
  /** ready, busy (op), blocked (blockedBy), broken (reason, fix), unknown (observedAt). */
  state: string
  op?: SdkOperation | null
  refusal?: SdkRefusal | null
  links: StoreBackupLink[]
  job: string | null
  postgresql?: PgServer | null
  /** PostgreSQL: the machines attached to it, as LayerFS lists them. */
  attached?: PgAttached[]
  /** Its format (`--with format`, #804): absent or null when the pinned CLI does not report it. */
  format?: StoreFormat | null
}

/** A Store's format: its version, the latest this LayerFS writes, the status word and its fix line. */
export interface StoreFormat {
  version: number | null
  latest: number | null
  /** `current`, `outdated` (an upgrade path exists), `unsupported` (none) or `newer` (a newer LayerFS wrote it). */
  status: 'current' | 'outdated' | 'unsupported' | 'newer' | (string & {})
  fix: string | null
}

/** GET /api/stores/:s/check: the reaches LayerFS recorded (host, then attached machines) and the doctor's failed checks. */
export interface PgCheck {
  store: string
  host: PgReach | null
  machines: PgAttached[]
  findings: { check: string | null, from: string | null, message: string, fix?: string }[]
  state?: string
  reason?: string | null
  error?: SdkRefusal
}

/** POST /api/stores/:s/attach: each machine's own answer. */
/** A refused reach: LayerFS's code, words and fix, and the connection step it stopped at (null when it never dialled). */
export interface PgReachError { code: string, message: string, fix?: string, step: string | null }

export interface PgAttachResult {
  store: string
  results: ({ machine: string, ok: true, outcome: string, latencyMs: number | null, version: string | null } | { machine: string, ok: false, error: PgReachError })[]
}

/** One place a connection test ran from: `/attach-test` (one machine) or a row of `/connection-test`; `ok: null` is a machine not checked because this computer's check failed first. */
export interface PgReachTest { ok: boolean | null, latencyMs: number | null, version: string | null, error: PgReachError | null }

/** `/connection-test`: the connection as it would be saved, tested from this computer, then every attached machine. */
export interface PgConnectionTest { store: string, here: PgReachTest, machines: (PgReachTest & { machine: string })[] }

/**
 * One file in a bucket (2.0 `backup list --detail`): its Store link, whether
 * the Store changed since its last backup (`behind`), whether the bucket's
 * copy is not the one the link last moved (`changed`), whether the linked
 * file is gone (`missing`); `behind`/`changed` null with `message` when
 * LayerFS could not read them.
 */
export interface BackupFile {
  file: string, store: string | null, bytes: number | null, modified: number | null
  behind: boolean | null, changed: boolean | null, missing: boolean, message: string | null
}

export interface BucketRow {
  name: string
  provider: string | null
  /** Its address when the record names one (Connect again prefills it; never a key). */
  url?: string | null
  /** The record's own state when it is not ready (`home get --with tree`), with its reason, fix and LayerFS's sentence. */
  state?: string | null
  reason?: string | null
  fix?: string | null
  message?: string | null
  /** When the host last asked LayerFS to list it (a refusal is a result too). */
  listed: number | null
  files: BackupFile[] | null
  /** Why the last listing gave no files: a `not_listed` reason or a refusal code, LayerFS's sentence, its fix line. */
  error: { code: string, message: string, fix?: string | null } | null
  stores: string[]
}

export type JobKind = 'push' | 'pull' | 'move' | 'backup' | 'restore' | 'compact' | 'upgrade'

/** A push, pull, move, backup, restore or compaction the host started. */
export interface StorageJob {
  id: string
  kind: JobKind
  store: string
  target: string
  from?: string | null
  half?: 'pull' | 'push' | null
  file: string | null
  started: number
  ended: number | null
  phase: string | null
  done: number | null
  total: number | null
  error: (SdkRefusal & { phase: string | null, note?: 'pulled' }) | null
  /** `stopped`: an upgrade its Cancel ended before COMMIT (nothing changed). */
  outcome?: 'succeeded' | 'failed' | 'interrupted' | 'unknown' | 'stopped' | null
  /** An upgrade's Cancel was asked; its CLI's reply still decides how it ends. */
  stopping?: boolean
  /** The host's fresh look after the job ended (`inspect`); an upgrade's is `store get --with format`. */
  observation?: { at: number, kind: string, value: any } | null
  phases?: { phase: string, half: string | null, at: number }[]
  /** The call's phases in order, when the host knows them before the run (a compaction). */
  steps?: readonly string[]
  /** A finished compaction's report (store.compact): `compacted` or `unchanged`, and what the Store's file or database shrank by. */
  result?: { outcome?: string | null, freed_bytes?: number | null, format_before?: number | null, format_after?: number | null } | null
  summary?: string | null
  /** A push placing a Store a New Store dialog just made. */
  made?: boolean
  /** Client-side monotonic high-water progress share (0..1) so bars never jump backward. */
  maxShare?: number
}

/** What a machine supports, as `machine list --detail` lists it (`sqlite`, `postgresql_sandbox`, `log`). */
export type MachineSupports = readonly string[]

/** GET /api/storage. */
export interface StorageView {
  machines: { name: string, platform: string, state: string | null, supports: MachineSupports | null, reason?: string | null }[]
  /** This computer (the native machine); absent from an older host. */
  computer?: { os: 'macos' | 'linux' | 'windows' | 'other', name: string | null, arch: string }
  stores: StoreRow[]
  buckets: BucketRow[]
  /** Whether the home tree read succeeded and includes unlinked buckets. */
  bucketInventoryComplete?: boolean
  jobs: StorageJob[]
  /** Whether the selected LayerFS runtime has store.compact; absent from an older host. */
  compact?: boolean
  /** Whether the selected LayerFS runtime has store.upgrade (#804); absent or false: no Upgrade… anywhere. */
  upgrade?: boolean
  /** Whether Store rows carry `format` (`--with format`). */
  format?: boolean
  /** The Store formats this LayerFS writes, by engine (`--version --json` `formats`). */
  formats?: { sqlite: number | null, postgresql: number | null } | null
  at: number
}


/** GET /api/projects: one project. */
export interface ProjectSummary {
  name: string
  key: string
  store: string
  kind: StoreFamily | null
  machine: string | null
  created: number | null
  storeState?: string | null
  storeBlockedBy?: { machine?: string, reason: string } | null
  storeReason?: string | null
  storeFix?: string | null
  refusal?: SdkRefusal | null
}

/** POST /api/projects and GET /api/project-inits/<id>. */
export interface ProjectInitJob {
  id: string
  name: string
  source: string | null
  started: number
  ended: number | null
  step: string
  progress: { phase?: string | null, done?: number | null, total?: number | null, files?: number, bytes?: number } | null
  project: ProjectSummary | null
  error: (SdkRefusal & { transport?: string }) | null
}

export interface WorkspaceInfo { ws: string, name?: string | null, branch: string, path: string }

/** GET /api/projects/<key>/sandboxes: one Sandbox. */
export interface SandboxInfo {
  id: string
  name: string
  state: string
  /** A broken one's reason (`lost`, `missing`: its daemon ended; the machine pages call it Lost). */
  reason?: string
  message?: string
  op?: SdkOperation | null
  project?: string | null
  refusal?: SdkRefusal | null
  image: string | null
  machine: string | null
  runtime?: string | null
  platform?: string
  created?: number | null
  workspaces: WorkspaceInfo[]
  unread?: boolean
}

/** GET /api/projects/<key>. */
export interface ProjectState {
  project: ProjectSummary
  branches: BranchInfo[]
  layers: { id: string, message: string, at: number | null, from: string | null }[]
  sandboxes: SandboxInfo[]
  last: CommitInfo | null
  commits: number | null
  store: { path: string | null, bytes: number | null }
  storage: { partial?: boolean, logical: number, canonical: number, stored: number, metadata: number, file: number, free: number } | null
}

/** GET /api/machines (what Push and Move need of it). */
export type MachinesView =
  | {
    available: true
    machines: { name: string, platform: string, state: string, supports?: MachineSupports }[]
    sandboxes: { name: string, machine: string | null, project: string | null, state?: string }[]
    live: Record<string, { freeDisk: number | null }>
  }
  | { available: false, reason: string }

/** `sessions.list`: one conversation bound to a project. */
export interface SessionRow {
  sessionId: string
  title: string | null
  branch: string | null
  state: string | null
  checkpoints: number | null
  updatedAt: number | null
}

// ---------- a project's own storage ----------

/** GET /api/projects/<key>/storage: this project's saves summed from their Commit counters. */
export interface ProjectStorageView {
  project: string
  /** Null while no save is counted yet; partial (see `partial`) during a first read. */
  totals: {
    saves: number
    merges: number
    branches: number
    publications: number
    commitLogical: number
    publicationLogical: number
    canonical: number
    stored: number
    /** Part of `stored`, not extra bytes. */
    metadata: number
  } | null
  /** Cumulative packed bytes at even steps through the saves, oldest first. */
  growth: number[]
  /** The newest saves, oldest first. */
  recent: { id: string, time: number | null, via: string | null, logical: number, stored: number, branch: string, message: string }[]
  updatedAt: number | null
  /** True until a first read of the history finishes: the totals so far. */
  partial: boolean
  /** The refresh running now. */
  building: { branches: number, branchesTotal: number, saves: number } | null
  /** Why the last refresh failed. */
  error: { code: string, message: string, detail: unknown } | null
  store: { name: string, projects: number | null, historyLogical?: number | null, canonical?: number | null, stored?: number | null, metadata?: number | null, file?: number | null, refusal?: unknown }
  main: { logical: number | null, files: number | null, directories: number | null, complete: boolean } | null
}
