/**
 * The Storage routes' bodies (LayerFS Connect's `host-api.ts`; the dsh-layerfs
 * host answers the same shapes).
 */
import type { BranchInfo, CommitInfo } from '../files/types.ts'

export interface SdkOperation { id: string, name: string, phase: string, started: number | null, uncertain: boolean }
export interface SdkRefusal { code: string, message: string, detail?: any }

export type StoreFamily = 'sqlite' | 'postgresql'
export type BackupState = 'current' | 'store_changed' | 'bucket_changed' | 'both_changed' | 'unknown' | 'unlinked' | 'missing'

export interface StoreBackupLink {
  bucket: string
  file: string
  last: { op: string, at: number | null, bytes: number | null } | null
}

export interface PgServer {
  target: string | null, reachable: boolean | null, version: string | null, latencyMs: number | null, error: string | null
  /** The Store's URL (LayerFS keeps no password in it). */
  url?: string | null
  /** The server as `host:port` (host in lower case, port 5432 by default). */
  server?: string | null
  database?: string | null
  user?: string | null
  /** The password's reference (`env:…`, `file:…`), or null when it names a file the host wrote (`saved`). */
  password?: string | null
  saved?: boolean
  /** The Store's synchronous_commit, or null (LayerFS's default). */
  synchronousCommit?: string | null
}

/** One Store: store.list with its store.status. */
export interface StoreRow {
  name: string
  kind: StoreFamily
  machine: string | null
  projects: string[]
  created: number | null
  /** The file's size; `stale` with `seen` when the machine did not answer and this is the last size read. */
  size: { bytes: number, file: number, wal: number, seen?: number, stale?: true } | null
  state: string
  op?: SdkOperation | null
  refusal?: SdkRefusal | null
  holders: number
  down: string | null
  links: StoreBackupLink[]
  job: string | null
  postgresql?: PgServer | null
  /** PostgreSQL: the machine its sessions run on by default (this DSH install's choice, never a LayerFS record). */
  runsOn?: string | null
  /** PostgreSQL: the machines that dial it with a connection of their own (store.update --machine). */
  ownConnections?: PgOwnConnection[]
}

/** A machine's own connection to a PostgreSQL Store; every other machine dials the Store's. */
export interface PgOwnConnection {
  machine: string
  /** Its own URL (no password), or null (the Store's URL, its own password). */
  url: string | null
  target: string | null
  /** Its own password reference, or null (the Store's, or a file the host wrote: `saved`). */
  password: string | null
  /** The reference names a file the host wrote from a typed password. */
  saved: boolean
}

/** GET /api/stores/:s/check?machine=: what `machine` found when it dialled the Store (store.status --machine). Nothing keeps it. */
export type PgCheck =
  | { machine: string, host: string | null, ok: true, at: number, version: string | null, latencyMs: number | null }
  | { machine: string, host: string | null, ok: false, error: { code: string, message: string } }

export interface BackupFile {
  file: string, store: string | null, state: BackupState, bytes: number | null, modified: number | null, reason: string | null
  /** The state was settled by this host (its Store is on another machine, which LayerFS does not read). */
  checked?: 'host'
  /** Unknown because its Store is on another machine and no backup from this host marked it. */
  untracked?: boolean
}

export interface BucketRow {
  name: string
  provider: string | null
  url?: string | null
  region?: string | null
  keys?: 'saved' | 'reference' | null
  key?: string | null
  listed: number | null
  files: BackupFile[] | null
  error: { code: string, message: string } | null
  stores: string[]
}

export type JobKind = 'push' | 'pull' | 'move' | 'backup' | 'restore' | 'compact'

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
  outcome?: 'succeeded' | 'failed' | 'interrupted' | 'unknown' | null
  phases?: { phase: string, half: string | null, at: number }[]
  /** The call's phases in order, when the host knows them before the run (a compaction). */
  steps?: readonly string[]
  /** A finished compaction's report (store.compact): the path it took and what the Store shrank by. */
  result?: { path?: string | null, physical_shrink?: number | null } | null
  summary?: string | null
}

/** What a machine supports, as `machine list --detail` lists it (`sqlite`, `postgresql_sandbox`, `log`). */
export type MachineSupports = readonly string[]

/** GET /api/storage. */
export interface StorageView {
  machines: { name: string, platform: string, state: string | null, supports: MachineSupports | null }[]
  /** This computer (the native machine); absent from an older host. */
  computer?: { os: 'macos' | 'linux' | 'windows' | 'other', name: string | null, arch: string }
  stores: StoreRow[]
  buckets: BucketRow[]
  jobs: StorageJob[]
  /** Whether the selected LayerFS runtime has store.compact; absent from an older host. */
  compact?: boolean
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
  storeDown?: string | null
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
