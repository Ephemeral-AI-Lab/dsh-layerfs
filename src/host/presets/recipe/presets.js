import { projectDefinition } from './projects.js'
import { hostNameFor } from '../../../shared/host-machine.ts'
// This computer's host machine (LayerFS #835): `macos-host` on macOS, `linux-host` on Linux.
export const HOST_MACHINE = hostNameFor(process.platform) ?? 'linux-host'
export const CONTENT_VERSION = 4
// Real-resource fixture descriptions. Nothing here fabricates LayerFS records.
// Half the Stores are SQLite (created, then pushed to `machine`); the other half
// are PostgreSQL databases on the preset's own server (postgresql.js), connected;
// `machine` is where their sessions run by default.
const stores = [
  { name: 'demo-studio', machine: HOST_MACHINE, projects: ['website', 'design'] },
  { name: 'demo-services', kind: 'postgresql', database: 'demo_services', machine: 'docker', projects: ['gateway', 'billing'] },
  { name: 'demo-build-cache', machine: 'demo-build', projects: ['compiler', 'sdk'] },
  { name: 'demo-experiments', kind: 'postgresql', database: 'demo_experiments', machine: 'demo-research', projects: ['embeddings', 'evaluation'] },
]
const vms = [
  { name: 'demo-build', platform: 'lima', cpus: 2, memory: '4G', disk: '20G' },
  { name: 'demo-research', platform: 'lima', cpus: 2, memory: '4G', disk: '20G' },
]
// The Starter preset: one SQLite Store on the Docker machine, one project, no VMs.
const starterStores = [{ name: 'demo-starter', machine: 'docker', projects: ['bookshelf'] }]
// `concurrentHistory`: dense histories built after every Store is placed (independent Branches in parallel).
export const presets = {
  quickstart: { description: 'One SQLite Store on the Docker machine with one project and a deep history of feature Branches, merges and releases. No virtual machines.', machines: ['docker'], stores: starterStores, sandboxes: false, concurrentHistory: true },
  studio: { concurrentHistory: true, description: 'Four machines; two SQLite Stores and two PostgreSQL Stores (a Docker PostgreSQL server the preset runs) with eight unequal project workloads and dense real commit, branch and publication histories. No sandboxes or workspaces.', machines: [HOST_MACHINE, 'docker', ...vms], stores, sandboxes: false },
}
// Kept addressable for existing private homes and cleanup; not offered as presets.
const legacyPresets = {
  starter: { description: 'Host + Docker, three stores and six projects; no new VMs.', machines: [HOST_MACHINE, 'docker'], stores: [...stores.slice(0, 2), { ...stores[2], machine: HOST_MACHINE }] },
  empty: { description: 'An initialized real home with built-in machines and no fixture stores.', machines: [HOST_MACHINE, 'docker'], stores: [] },
}
export function presetOf(name) {
  if (!Object.hasOwn(presets, name) && !Object.hasOwn(legacyPresets, name)) throw new Error(`Unknown preset ${name}.`)
  return structuredClone(presets[name] ?? legacyPresets[name])
}
export function sourceFiles(name) {
  return structuredClone(projectDefinition(name).files)
}
