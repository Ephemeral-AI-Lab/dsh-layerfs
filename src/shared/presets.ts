/**
 * The Presets API's shapes (`/api/demo-presets…` on the `http` operation),
 * shared by the host manager and the Presets page. Port of LayerFS Connect
 * `shared/demo-presets.d.ts` for one home (the plugin's own): no environment
 * switching, no CLI Activity; a job carries its own log instead.
 */

export type PresetExecutionMode = 'filesystem' | 'mixed'

/** A DSH session whose open Sandbox blocks a reset. */
export interface BusySession {
  readonly id: string
  readonly project: string | null
}

/** What a reset does to dsh-layerfs's own records (the DSH side of the plan). */
export interface DshImpact {
  /** Bound project sessions: the reset is refused until they are closed. */
  readonly sessions: readonly BusySession[]
  /** Projects with a DSH workspace that the reset drops, with their session count. */
  readonly workspaces: readonly { readonly project: string, readonly sessions: number }[]
}

export interface EnvironmentResetPlan {
  readonly environment: string
  readonly home: string
  readonly homeId: string
  readonly scope: 'environment'
  readonly remove: { readonly stores: string[], readonly sandboxes: string[], readonly machines: string[], readonly workspaces: string[] }
  readonly disconnect: string[]
  readonly unknownSandboxes: string[]
  readonly workspaceGroups?: { sandbox: string, workspaces: string[] }[]
  readonly startMachines: string[]
  readonly projects: number
  readonly projectKeys: string[]
  readonly stopDocker: boolean
  readonly detectedMachines?: { name: string, state: string, platform?: string }[]
  readonly signature: string
  readonly executionMode?: PresetExecutionMode
  readonly dsh: DshImpact
}

export interface EnvironmentResetReceipt extends Omit<EnvironmentResetPlan, 'dsh' | 'environment'> {
  readonly verified: boolean
  readonly remaining: string[]
  readonly warnings: string[]
  readonly completed: string[][]
  readonly error?: { code: string, message: string }
}

export interface PresetProjectTask {
  id: string
  project: string
  machine: string
  state: 'waiting' | 'running' | 'completed' | 'failed' | 'stopped'
  completed: number
  total: number
  tier?: number
  commits?: number
  branches?: number
  layers?: number
  targetCommits?: number
  targetBranches?: number
  targetLayers?: number
  error?: string
  errorCode?: string
  started?: number
  ended?: number
}

export interface PresetProgress {
  stage: 'checking' | 'resetting' | 'building' | 'verifying'
  completed: number
  total: number | null
  label: string
  historyCompleted?: number
  historyTotal?: number
  workspaceCoverage?: { completed: number, required: number, total: number }
  tasks?: PresetProjectTask[]
}

/** One log line of a job: when, and the runner's words. */
export interface PresetLogLine {
  readonly at: number
  readonly text: string
}

export interface PresetJob {
  id: string
  requestId: string
  fingerprint: string
  preset: string
  command: 'environment-reset'
  executionMode: PresetExecutionMode
  rebuild: boolean
  actionId: string | null
  rebuildActionId?: string
  state: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted'
  phase: string
  created: number
  started?: number
  ended?: number
  progress?: PresetProgress
  cleanup?: EnvironmentResetReceipt
  presetVerified?: boolean
  /** Projects whose DSH workspace and session records were dropped after their Store was removed. */
  forgotten?: string[]
  error?: { code: string, message: string }
  /** The last lines the runner reported (newest last, at most LOG_LINES). */
  log: PresetLogLine[]
}

export interface PresetProjectDefinition {
  store: string
  name: string
  title: string
  description: string
  branches: string[]
  tier?: number
  cycles?: number
  layers?: number
  commands?: number
  workspaceRevisions?: number
  authoredRevisions?: number
  sandboxLimit?: number
  workspaceLimit?: number
  history: { commits: number, branches: number, merges: number, publishes: number }
}

export interface DemoPreset {
  id: string
  description: string
  executionMode: PresetExecutionMode
  contentVersion: number
  contentReady: boolean
  projectDefinitions: PresetProjectDefinition[]
  machineDefinitions: { name: string, platform: string, cpus?: number, memory?: string, disk?: string }[]
  projectGroups: { store: string, machine: string, projects: string[] }[]
  machines: string[]
  stores: number
  projects: number
  sandboxes: number
  workspaces: number
  requirements: string[]
  home: string
  state: string
  /** The LayerFS home exists (it can be reset). */
  initialized: boolean
  /** A preset build prepared this home's manifest. */
  built: boolean
  settings: { sandboxes: boolean, executionMode: PresetExecutionMode } | null
  job: PresetJob | null
}

export interface DemoPresets {
  items: DemoPreset[]
  home: string
  busy: boolean
}

export interface PresetScriptCommand {
  phase: 'reset' | 'build' | 'verify'
  argv: string[]
  input?: string
  note?: string
  key?: string
  dependsOn?: string[]
  lane?: string
  commitFrom?: string
}

export interface PresetScript {
  preset: string
  total: number
  offset: number
  next: number | null
  snapshot?: string
  commands: PresetScriptCommand[]
  dynamicReset: boolean
  configuration: Record<string, unknown> & { home?: string, cli?: string | null, executionMode?: PresetExecutionMode, historyLimits?: { concurrency: number, perStore: number, perProject: number } }
}

/** Lines a job keeps. */
export const LOG_LINES = 200
