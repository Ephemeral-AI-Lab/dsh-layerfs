import type { Context } from '@deepseek-ai/cordis'
import { SimulationAdapter } from './model.ts'
import { SimulationRuntime } from './runtime.ts'

export const name = 'dsh-layerfs-simulations'
export const inject = ['layerfs', 'layerfsRemote', 'layerfsSessions', 'llm', 'agents', 'sessionController', 'agentDefaultModel']

declare module '@deepseek-ai/cordis' {
  interface Context { layerfsSimulations: SimulationRuntime }
}

export function simulationArguments(raw: string): { project: string; machine: string; mixed: boolean } {
  const words = raw.trim().split(/\s+/).filter(Boolean)
  const parsed: { project: string; machine: string; mixed: boolean } = { project: '', machine: '', mixed: false }
  const seen = new Set<string>()
  for (let i = 0; i < words.length; i++) {
    const flag = words[i]
    if (seen.has(flag)) throw new Error(`Duplicate simulation option: ${flag}`)
    seen.add(flag)
    if (flag === '--mixed') parsed.mixed = true
    else if (flag === '--project' || flag === '--machine') {
      const value = words[++i]
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
      parsed[flag === '--project' ? 'project' : 'machine'] = value
    } else throw new Error(`Unknown simulation option: ${flag}`)
  }
  if (!parsed.project || !parsed.machine) throw new Error('Use /simulation --project <preset> --machine <machine> [--mixed]')
  return parsed
}

export function apply(ctx: Context): void {
  const runtime = new SimulationRuntime(ctx)
  ctx.provide('layerfsSimulations', runtime)
  ctx.effect(() => () => runtime.dispose(), 'dsh-layerfs: script admission')
  ctx.llm.registerAdapter(['simulation'], new SimulationAdapter(runtime))
  ctx.on('agent/created', async ({ agent }: any) => { await runtime.created(agent); return undefined }, { prepend: true })
  ctx.on('agent/pre-step', (payload: any, next: any) => runtime.preStep(payload, next), { prepend: true })
  ctx.on('session/event', (session: any, event: any) => { if (event?.type === 'turn/end') runtime.turnEnded(session) })
  ctx.on('agent/inbox/inserted', ({ agent, message }: any) => runtime.inserted(agent, message))
  ctx.on('agent/error', ({ agent, error }: any) => runtime.fail(agent, error))
  ctx.on('agent/turn-stopping', async ({ agent }: any) => runtime.turnStopping(agent))
  ctx.on('tools/execute' as any, (execution: any, next: any) => runtime.executeTool(execution, next), { prepend: true })
  ctx.layerfsRemote.operate(ctx, {
    'simulation.launch': (args: any, signal) => runtime.launch(args, signal),
    'simulation.stop': (args: any) => runtime.stop(String(args.sessionId)),
    'simulation.script': (args: any) => runtime.inspect(String(args.sessionId)),
    'simulation.status': (args: any) => runtime.inspect(String(args.sessionId)).then(({ state, locked }: any) => ({ state, locked })),
  })
  ctx.inject(['commands' as never], scope => {
    const commands = (scope as any).commands
    commands.register({
      name: 'simulation', description: 'Start project work from a prepared action script', input: { hint: '--project <preset> --machine <machine> [--mixed]' },
      handler: async ({ agent, rawInput, signal }: any) => {
        const options = simulationArguments(rawInput)
        const result = await runtime.launch({ ...options, cwd: agent.session.header.cwd, ordinaryModel: agent.model.current() }, signal)
        ctx.layerfs.emit('simulation-open', { sourceSessionId: String(agent.id), sessionId: result.sessionId })
        return { kind: 'success', text: `Opened project session ${result.sessionId}.` }
      },
    })
  })
  void runtime.recover().catch(error => ctx.logger('layerfs').warn('simulation recovery: %s', String(error)))
}
