/**
 * The Machines page (port of LayerFS Connect's Machines, docs/ui/machines.md):
 * the board of machines this LayerFS home runs on, one machine's page (its
 * Sandboxes, Stores and spec), and one Sandbox's page. Where the page is
 * stays in local state; there is no router. Reading the page starts nothing.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Board } from './Board.tsx'
import { MachinesProvider, useMachinesContext, type MachinesPageProps } from './context.tsx'
import { MachineDetail } from './MachineDetail.tsx'
import { SandboxDetail } from './SandboxDetail.tsx'

/** Where the page is. */
export type View =
  | { kind: 'board' }
  | { kind: 'machine', name: string, tab?: 'sandboxes' | 'stores' | 'spec' }
  | { kind: 'sandbox', machine: string, name: string }

export function MachinesPage(props: MachinesPageProps): ReactNode {
  return (
    <MachinesProvider props={props}>
      <MachinesRoot />
    </MachinesProvider>
  )
}

function MachinesRoot(): ReactNode {
  const { activate } = useMachinesContext()
  const [view, setView] = useState<View>({ kind: 'board' })
  useEffect(() => activate(), [activate])
  if (view.kind === 'machine') return <MachineDetail key={view.name} name={view.name} initialTab={view.tab} go={setView} />
  if (view.kind === 'sandbox') return <SandboxDetail key={`${view.machine}:${view.name}`} machine={view.machine} name={view.name} go={setView} />
  return <Board go={setView} />
}
