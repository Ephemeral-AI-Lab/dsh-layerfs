/*
 * General reset of the LayerFS home: every store, sandbox, workspace and custom
 * machine it holds, dependency first, through the real CLI. Port of LayerFS
 * Connect `host/environment-reset.js` without its CLI Activity recorder: the
 * receipt (`<state>/environment-reset.json`) and the job's log are the record.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { CliInventory } from './inventory.js'

const sorted = items => [...items].sort((a, b) => a.name.localeCompare(b.name))
const builtIn = name => ['native', 'docker'].includes(name)
const save = (file, value) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); renameSync(tmp, file) }

/** A refusal while other work holds the home (answered 409). */
export const fixtureBusy = message => Object.assign(new Error(message), { status: 409, code: 'ConnectBusy' })

/** The live owner of a lock file, or null when there is none or its process ended. */
export function liveReceipt(file) {
  let receipt
  try { receipt = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return null; throw fixtureBusy('The preset lock is unreadable. Inspect the presets state folder.') }
  if (!Number.isInteger(receipt.pid) || receipt.pid <= 0) throw fixtureBusy('The preset lock has an invalid process ID. Inspect the presets state folder.')
  try { process.kill(receipt.pid, 0) } catch (e) { if (e.code === 'ESRCH') return null; throw e }
  return receipt
}

/** General reset of one explicitly selected home. Never selects by fixture ownership. */
export class EnvironmentReset extends CliInventory {
  constructor({ spec, driver, report = () => {}, progress = () => {} }) { super(driver); this.spec = spec; this.report = report; this.progress = progress; this.lock = join(spec.state, 'demo-fixtures.lock') }
  identity() {
    const id = JSON.parse(readFileSync(join(this.spec.home, 'layerfs.json'), 'utf8')).id
    if (!id) throw new Error('The selected environment has no valid LayerFS home identity.')
    return id
  }
  async plan() {
    const homeId = this.identity(), machines = sorted(await this.inventory('machine')), stores = sorted(await this.inventory('store')), sandboxes = sorted(await this.inventory('sandbox'))
    for (const row of [...machines, ...stores, ...sandboxes]) if (row.op) throw fixtureBusy(`${row.name} has an active or unresolved operation. Inspect its status before resetting.`)
    const workspaces = [], unknownSandboxes = [], workspaceGroups = []
    for (const box of sandboxes) {
      const detail = await this.sandboxDetails(box.name, { allowDown: true })
      if (detail.incomplete) unknownSandboxes.push(box.name)
      else {
        const names = detail.workspaces.map(ws => ws.ws)
        workspaces.push(...names); workspaceGroups.push({ sandbox: box.name, workspaces: names })
      }
    }
    const remove = { stores: stores.filter(s => s.kind !== 'postgresql').map(s => s.name), sandboxes: sandboxes.map(s => s.name), machines: machines.filter(m => !builtIn(m.name)).map(m => m.name), workspaces: workspaces.sort() }
    const disconnect = stores.filter(s => s.kind === 'postgresql').map(s => s.name)
    const startMachines = [...new Set([...stores, ...sandboxes].map(r => r.machine).filter(name => name && name !== 'native'))].filter(name => !['running', 'ready'].includes(machines.find(m => m.name === name)?.state)).sort()
    const detectedMachines = machines.map(({ name, state, platform }) => ({ name, state, platform }))
    const projectKeys = stores.flatMap(s => (s.projects ?? []).map(p => `${s.name}/${p}`)).sort()
    const plan = { home: this.spec.home, homeId, remove, disconnect, unknownSandboxes, workspaceGroups, startMachines, detectedMachines, projects: projectKeys.length, projectKeys, stopDocker: machines.some(m => m.name === 'docker' && !['stopped', 'ready'].includes(m.state)), scope: 'environment' }
    const identities = [machines, stores, sandboxes].map(rows => rows.map(({ name, id, created, machine, kind, projects }) => ({ name, id, created, machine, kind, projects })))
    const signature = createHash('sha256').update(JSON.stringify({ ...plan, identities })).digest('hex')
    return { ...plan, signature }
  }
  async remaining() {
    const stores = await this.inventory('store'), sandboxes = await this.inventory('sandbox'), machines = await this.inventory('machine')
    return [...stores.map(r => `store ${r.name}`), ...sandboxes.map(r => `sandbox ${r.name}`), ...machines.filter(m => !builtIn(m.name)).map(r => `machine ${r.name}`), ...machines.filter(m => m.name === 'docker' && !['stopped', 'ready'].includes(m.state)).map(() => 'running Docker worker')]
  }
  async run({ expectedPlan, onReady, assertIdle, beforeRemove, afterCleanup }) {
    mkdirSync(this.spec.state, { recursive: true, mode: 0o700 })
    let fd
    try { fd = openSync(this.lock, 'wx', 0o600) } catch (e) {
      if (e.code !== 'EEXIST') throw e
      if (liveReceipt(this.lock)) throw fixtureBusy('Another preset build or reset is running.')
      throw fixtureBusy('A previous operation left a stale lock. Inspect its status and receipt before removing the lock and resetting.')
    }
    const action = { id: randomUUID(), name: 'environment.reset', label: 'Reset LayerFS environment', target: this.spec.home }
    writeFileSync(fd, JSON.stringify({ pid: process.pid, actionId: action.id })); closeSync(fd)
    let receipt
    try {
      this.progress({ stage: 'checking', completed: 0, total: null, label: 'Checking environment inventory' })
      await assertIdle()
      await this.driver.discover()
      const plan = await this.plan()
      if (plan.signature !== expectedPlan) throw Object.assign(new Error('The environment changed since confirmation. Review the reset plan again.'), { code: 'Conflict', status: 409 })
      receipt = { ...plan, actionId: action.id, verified: false, completed: [], remaining: [], warnings: [], at: Date.now() }
      const file = join(this.spec.state, 'environment-reset.json')
      save(file, receipt)
      let cleanup
      try {
        await onReady?.(action)
        await beforeRemove?.(plan)
        let completed = 0
        const total = plan.unknownSandboxes.length ? null : plan.startMachines.length + Object.values(plan.remove).reduce((n, rows) => n + rows.length, 0) + plan.disconnect.length + Number(plan.stopDocker || plan.startMachines.includes('docker'))
        this.progress({ stage: 'resetting', completed, total, label: 'Removing detected resources' })
        const mutate = async argv => {
          this.progress({ stage: 'resetting', completed, total, label: `layerfs ${argv.join(' ')}` })
          const result = await this.driver.invoke(argv)
          receipt.completed.push(argv); completed++
          this.progress({ stage: 'resetting', completed, total, label: `Completed: layerfs ${argv.join(' ')}` })
          if (result?.note || result?.left) receipt.warnings.push(result.note ?? result.left)
          save(file, receipt); return result
        }
        this.report('Starting machines needed to reach their resources')
        for (const machine of plan.startMachines) await mutate(['machine', 'start', machine])
        this.report('Unmounting workspaces and closing sandboxes')
        const workspaces = []
        for (const name of plan.remove.sandboxes) {
          const box = await this.sandboxDetails(name)
          for (const workspace of box.workspaces) { workspaces.push(workspace.ws); await mutate(['workspace', 'unmount', workspace.ws, '--discard']) }
          await mutate(['sandbox', 'close', name])
        }
        receipt.remove.workspaces = workspaces
        this.report('Removing stores and disconnecting PostgreSQL stores')
        for (const name of plan.remove.stores) await mutate(['store', 'remove', name])
        for (const name of plan.disconnect) await mutate(['store', 'disconnect', name])
        this.report('Removing custom machines and stopping Docker')
        for (const name of plan.remove.machines) await mutate(['machine', 'remove', name])
        const docker = (await this.inventory('machine')).find(m => m.name === 'docker')
        if (docker && !['stopped', 'ready'].includes(docker.state)) await mutate(['machine', 'stop', 'docker'])
        this.progress({ stage: 'verifying', completed: 0, total: 1, label: 'Verifying empty environment' })
        this.report('Verifying empty environment against LayerFS inventory')
        if (this.identity() !== plan.homeId) throw new Error('The LayerFS home identity changed during reset.')
        receipt.remaining = await this.remaining()
        if (receipt.remaining.length) throw new Error(`Environment reset verification failed: ${receipt.remaining.join(', ')}. Inspect the remaining resources before continuing.`)
        this.progress({ stage: 'verifying', completed: 1, total: 1, label: 'Empty environment verified' })
        receipt.verified = true; receipt.ended = Date.now(); save(file, receipt)
        cleanup = receipt
      } catch (e) {
        try { receipt.remaining = await this.remaining() } catch (readError) { receipt.warnings.push(`Remaining inventory could not be read: ${readError.message}`) }
        receipt.error = { code: e.code ?? 'Failed', message: e.message }; receipt.ended = Date.now(); save(file, receipt)
        throw e
      }
      // Build continues under this same lease.
      return afterCleanup ? await afterCleanup(cleanup, action.id) : cleanup
    } finally { unlinkSync(this.lock) }
  }
}
