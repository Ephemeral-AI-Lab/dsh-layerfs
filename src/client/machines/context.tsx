/**
 * What every Machines component reads: the slot props (DSH's `t` for the
 * `layerfsMachines` namespace, the renderer-bound `use*` hooks over the
 * controller's sources, and its callbacks), passed down once by the page.
 */
import { createContext, useContext, useMemo } from 'react'
import type { LayerfsApi } from '../api.ts'
import { openStorage } from '../projects/navigation.ts'
import type { DoctorT } from '../doctor/locale.ts'
import type { RefusalLabels } from '../ui/index.tsx'
import type { MachinesFace, ReadState } from './controller.ts'
import type { MachinesKey } from './locale.ts'
import { kindKey, type MachineStartup, type MachinesView, type RuntimeStatus, type StateLook, type Words } from './model.ts'

/** DSH's translate seat for this namespace: `{name}` placeholders take string values. */
export type Translate = (key: MachinesKey, params?: Record<string, string>) => string

/** Where a machine page sends you: the board, one machine, or one Sandbox (each a Storage page). */
export type View =
  | { kind: 'board' }
  | { kind: 'machine', name: string }
  | { kind: 'sandbox', machine: string, name: string }

/** The Storage page a view opens. */
export function tabOfView(view: View): string {
  return view.kind === 'board' ? 'machines' : view.kind === 'machine' ? `machine:${view.name}` : `sandbox:${view.machine}/${view.name}`
}

/** A renderer-bound selector hook over one source. */
export type Hook<T> = <S>(selector: (snapshot: T) => S) => S

/** The props the DSH `main` slot renderer gives the Machines page. */
export interface MachinesPageProps extends Omit<MachinesFace, 'hooks'> {
  t: Translate
  /** The host API (targeted Doctor launches through it). */
  api: LayerfsApi
  /** The `layerfsDoctor` namespace's translate seat. */
  doctorT: DoctorT
  useMachines: Hook<ReadState<MachinesView>>
  useStartups: Hook<Readonly<Record<string, MachineStartup>>>
  useRuntime: Hook<ReadState<RuntimeStatus>>
  useConnected: Hook<boolean>
  /** Open a Storage page in place (set by the Storage page); elsewhere a link opens the Storage page. */
  openTab?: ((id: string) => void) | undefined
}

export interface MachinesContext extends MachinesPageProps {
  /** Open a Storage page: `store:<name>`, `machine:<name>`, `machines`, … */
  openStorageTab: (id: string) => void
  /** Go to a machine view (a Storage page). */
  go: (view: View) => void
  /** Words (a key and its values) in this locale. */
  tw: (words: Words) => string
  /** A platform's name in this locale, else its raw name. */
  kind: (platform: string) => string
  /** A state's word in this locale, else the word as it came. */
  stateWord: (look: StateLook) => string
  refusal: RefusalLabels
}

const Ctx = createContext<MachinesContext | null>(null)

const ENTITY: Record<string, MachinesKey> = {
  sandbox: 'entitySandbox', store: 'entityStore', lease: 'entityProcess', machine: 'entityMachine', project: 'entityProject', workspace: 'entityWorkspace',
}

export function MachinesProvider({ props, children }: { props: MachinesPageProps, children: React.ReactNode }): React.ReactNode {
  const { t } = props
  const value = useMemo<MachinesContext>(() => {
    const tw = (words: Words) => t(words.key, words.values)
    const openStorageTab = props.openTab ?? ((id: string) => openStorage(props.api, id))
    return {
      ...props,
      openStorageTab,
      go: (view: View) => openStorageTab(tabOfView(view)),
      tw,
      kind: (platform) => { const k = kindKey(platform); return k ? t(k) : platform },
      stateWord: (look) => (look.label ? t(look.label) : look.raw || t('stateUnknown')),
      refusal: {
        category: (c) => t(c === 'usage' ? 'refusalUsage' : c === 'unavailable' ? 'refusalUnavailable' : c === 'unknown' ? 'refusalUnknown' : 'refusalLayerfs'),
        inTheWay: t('refusalInTheWay'),
        kind: (k) => (ENTITY[k] ? t(ENTITY[k]) : k),
        phase: (p) => t('refusalPhase', { phase: p }),
        operation: (o) => t('refusalOperation', { op: o }),
      },
    }
  }, [props])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useMachinesContext(): MachinesContext {
  const value = useContext(Ctx)
  if (!value) throw new Error('Machines components render inside MachinesProvider')
  return value
}
