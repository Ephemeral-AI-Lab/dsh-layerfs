import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, lstat, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { SIMULATION_VERSION } from './compiler.ts'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
async function durableWrite(path: string, content: string) {
  const file = await open(path, 'wx', 0o600)
  try { await file.writeFile(content); await file.sync() } finally { await file.close() }
}
async function syncDirectory(path: string) {
  const file = await open(path, 'r')
  try { await file.sync() } finally { await file.close() }
}
export async function writeSimulationPackage(root: string, compiled: any): Promise<string> {
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(compiled.manifest.runId)) throw new Error('Invalid simulation run ID')
  const directory = resolve(root, 'simulations', compiled.manifest.runId)
  await mkdir(dirname(directory), { recursive: true })
  await mkdir(directory, { mode: 0o700 })
  for (const [relative, content] of Object.entries(compiled.files)) {
    const path = resolve(directory, relative)
    if (!path.startsWith(directory + sep)) throw new Error('Invalid package path')
    await mkdir(dirname(path), { recursive: true })
    await durableWrite(path, String(content))
  }
  await durableWrite(join(directory, 'journal.jsonl'), '')
  await syncDirectory(directory)
  return directory
}
export async function validateSimulationPackage(input: string): Promise<any> {
  const directory = await realpath(input)
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  if (manifest.version !== SIMULATION_VERSION || !manifest.hashes || typeof manifest.hashes !== 'object') throw new Error('Invalid simulation manifest')
  for (const [relative, hash] of Object.entries(manifest.hashes)) {
    const path = resolve(directory, relative)
    if (!path.startsWith(directory + sep) || typeof hash !== 'string' || (await lstat(path)).isSymbolicLink() || !(await realpath(path)).startsWith(directory + sep)) throw new Error('Invalid package file reference')
    if (digest(await readFile(path)) !== hash) throw new Error(`Simulation package hash changed: ${relative}`)
  }
  if (!manifest.hashes['plan.json']) throw new Error('Missing simulation plan hash')
  const plan = JSON.parse(await readFile(join(directory, 'plan.json'), 'utf8'))
  for (const agent of plan.agents ?? []) if (manifest.hashes[agent.path] !== agent.hash) throw new Error('Invalid script identity')
  return manifest
}
/** An exclusive claim lock serializes atomic manifest owner changes. A crashed claim blocks replay. */
export async function claimSimulationExecution(directory: string, owner = 'host'): Promise<void> {
  await validateSimulationPackage(directory)
  const lock = join(directory, '.claim')
  try { await mkdir(lock) } catch { throw new Error('Simulation execution ownership is already claimed or uncertain') }
  try {
    const path = join(directory, 'manifest.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    if (manifest.owner) throw new Error(`Simulation package already owned by ${manifest.owner.name}; execution cannot be replayed`)
    manifest.owner = { name: owner, pid: process.pid, claimedAt: new Date().toISOString() }
    const pending = join(directory, '.manifest-claim.json')
    await durableWrite(pending, json(manifest))
    await rename(pending, path)
    await syncDirectory(directory)
  } finally { await rm(lock, { recursive: true }) }
}
export type JournalRecord = { type: string; [key: string]: any }
/** One journal, serialized and fsynced before the caller can dispatch subsequent work. */
export class SimulationJournal {
  readonly records: JournalRecord[] = []
  private pending: Promise<unknown> = Promise.resolve()
  private poisoned = false
  private receiptCursor = 0
  private receiptCache: Record<string, any> = {}
  readonly directory: string
  private constructor(directory: string) { this.directory = directory }
  static async open(directory: string): Promise<SimulationJournal> {
    const journal = new SimulationJournal(directory)
    const path = join(directory, 'journal.jsonl')
    const raw = await readFile(path, 'utf8')
    const lines = raw.split('\n')
    const complete = raw.endsWith('\n') ? lines.slice(0, -1) : lines.slice(0, -1)
    for (const line of complete) {
      if (!line.trim()) throw new Error('Corrupt simulation journal record')
      let event: JournalRecord
      try { event = JSON.parse(line) } catch { throw new Error('Corrupt simulation journal before final record') }
      if (!event || typeof event.type !== 'string' || event.seq !== journal.records.length + 1) throw new Error('Invalid simulation journal sequence')
      journal.records.push(event)
    }
    // A torn final record is evidence of interruption; remove only that fragment before future appends.
    if (!raw.endsWith('\n')) {
      const file = await open(path, 'r+')
      try { await file.truncate(Buffer.byteLength(complete.join('\n') + (complete.length ? '\n' : ''))); await file.sync() } finally { await file.close() }
    }
    return journal
  }
  append(event: JournalRecord): Promise<JournalRecord> {
    const task = this.pending.then(async () => {
      if (this.poisoned) throw new Error('Simulation journal durability is uncertain')
      const record = { ...event, seq: this.records.length + 1, at: new Date().toISOString() }
      const file = await open(join(this.directory, 'journal.jsonl'), 'a', 0o600)
      try { await file.writeFile(JSON.stringify(record) + '\n'); await file.sync() } catch (error) { this.poisoned = true; throw error } finally { await file.close() }
      this.records.push(record)
      return record
    })
    this.pending = task.catch(() => {})
    return task
  }
  get receipts(): Record<string, any> {
    for (; this.receiptCursor < this.records.length; this.receiptCursor++) {
      const record = this.records[this.receiptCursor]
      if (record.type === 'result' && record.ok === true) this.receiptCache[record.stepKey] = record.receipt
    }
    return this.receiptCache
  }
  async bind(agentKey: string, sessionId: string): Promise<void> {
    const existing = this.records.find(record => record.type === 'binding' && record.agentKey === agentKey)
    if (existing) { if (existing.sessionId !== sessionId) throw new Error('Agent is already bound to another session'); return }
    await this.append({ type: 'binding', agentKey, sessionId })
  }
}
