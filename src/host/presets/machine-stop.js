/* Stop-only Presets Reset. Never starts workers or removes registered resources. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CliInventory } from './inventory.js'
import { fixtureBusy, liveReceipt } from './environment-reset.js'

const save = (file, value) => { const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, file) }
const terminal = machine => !machine.op && (machine.name === 'native' ? ['ready', 'stopped'].includes(machine.state) : ['stopped', 'down'].includes(machine.state))

export class MachineStop extends CliInventory {
  constructor({ spec, driver, report = () => {}, progress = () => {} }) { super(driver); this.spec = spec; this.report = report; this.progress = progress; this.lock = join(spec.state, 'demo-fixtures.lock') }
  identity() {
    const id = JSON.parse(readFileSync(join(this.spec.home, 'layerfs.json'), 'utf8')).id
    if (!id) throw new Error('The selected environment has no valid LayerFS home identity.')
    return id
  }
  async plan() {
    const discovery = await this.driver.discover()
    const stop = discovery?.calls?.find(call => call.family === 'machine' && call.call === 'stop')
    if (!stop?.options?.some(option => option.name === 'force' && option.kind === 'bool')) {
      throw Object.assign(new Error('Reset requires machine.stop with the force option, which the selected LayerFS CLI does not advertise. Choose a compatible CLI and matching daemon in Machines → LayerFS runtime → Change, then review Reset again. No machines were stopped.'), {
        code: 'CliIncompatible', status: 409,
      })
    }
    const homeId = this.identity()
    const machines = (await this.inventory('machine')).sort((a, b) => a.name.localeCompare(b.name))
    const detectedMachines = machines.map(({ name, state, platform }) => ({ name, state, platform }))
    const plan = { home: this.spec.home, homeId, scope: 'machines', stopMachines: machines.map(machine => machine.name), detectedMachines }
    const identities = machines.map(({ name, id, created, platform }) => ({ name, id, created, platform }))
    const signature = createHash('sha256').update(JSON.stringify({ ...plan, identities })).digest('hex')
    return { ...plan, signature }
  }
  async run({ expectedPlan, onReady, assertIdle, onStopped }) {
    mkdirSync(this.spec.state, { recursive: true, mode: 0o700 })
    let descriptor
    try { descriptor = openSync(this.lock, 'wx', 0o600) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (liveReceipt(this.lock)) throw fixtureBusy('Another preset build or reset is running.')
      throw fixtureBusy('A previous operation left a stale lock. Inspect its receipt before starting another operation.')
    }
    const action = { id: randomUUID(), name: 'machine.stop-all', label: 'Force-close LayerFS machines', target: this.spec.home }
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, actionId: action.id })); closeSync(descriptor)
    const file = join(this.spec.state, 'machine-stop.json')
    let receipt
    try {
      this.progress({ stage: 'checking', completed: 0, total: null, label: 'Checking registered machines' })
      await assertIdle?.()
      const plan = await this.plan()
      if (plan.signature !== expectedPlan) throw Object.assign(new Error('The machine inventory changed since confirmation. Review the stop plan again.'), { code: 'Conflict', status: 409 })
      receipt = { ...plan, actionId: action.id, verified: false, completed: [], results: [], remaining: [], warnings: [], at: Date.now() }
      save(file, receipt)
      await onReady?.(action)
      const failures = []
      for (const [index, name] of plan.stopMachines.entries()) {
        const argv = ['machine', 'stop', name, '--force']
        this.progress({ stage: 'resetting', completed: index, total: plan.stopMachines.length, label: `layerfs ${argv.join(' ')}` })
        this.report(`Force-closing machine ${name}`)
        try {
          const result = await this.driver.invoke(argv)
          if (result?.forced !== true || result?.name !== name || !terminal(result)) throw new Error(`Force-stop outcome could not be confirmed for ${name}`)
          receipt.completed.push(argv)
          receipt.results.push({ machine: name, state: result.state, forced: true, stoppedSandboxes: result.stopped_sandboxes ?? [], unknown: result.unknown ?? [] })
          for (const workspace of result.unknown ?? []) receipt.warnings.push(`Uncommitted workspace state may be lost or unknown: ${workspace}`)
          save(file, receipt)
          await onStopped?.(name)
        } catch (error) {
          failures.push(`${name}: ${error.message}`)
          receipt.warnings.push(`${name}: ${error.message}`)
        }
        save(file, receipt)
      }
      this.progress({ stage: 'verifying', completed: 0, total: 1, label: 'Verifying machines are stopped' })
      if (this.identity() !== plan.homeId) throw new Error('The LayerFS home identity changed during reset.')
      const machines = await this.inventory('machine')
      const byName = new Map(machines.map(machine => [machine.name, machine]))
      receipt.remaining = [
        ...plan.stopMachines.flatMap(name => !byName.has(name) ? [`machine registration missing: ${name}`] : terminal(byName.get(name)) ? [] : [`machine still running: ${name}`]),
        ...machines.filter(machine => !plan.stopMachines.includes(machine.name)).map(machine => `new machine registration: ${machine.name}`),
      ]
      if (failures.length || receipt.remaining.length) throw new Error(`Machine reset could not be verified: ${[...failures, ...receipt.remaining].join('; ')}`)
      receipt.verified = true; receipt.ended = Date.now(); save(file, receipt)
      this.progress({ stage: 'verifying', completed: 1, total: 1, label: 'Machines closed; saved projects retained' })
      return receipt
    } catch (error) {
      if (receipt) { receipt.error = { code: error.code ?? 'Failed', message: error.message }; receipt.ended = Date.now(); save(file, receipt) }
      throw error
    } finally { unlinkSync(this.lock) }
  }
}
