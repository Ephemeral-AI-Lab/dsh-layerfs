/**
 * What every Machines component reads: the slot props (DSH's `t` for the
 * `layerfsMachines` namespace, the renderer-bound `use*` hooks over the
 * controller's sources, and its callbacks), passed down once by the page.
 */
import { createContext, useContext, useMemo } from 'react'
import type { RefusalLabels } from '../ui/index.tsx'
import type { MachinesFace, ReadState } from './controller.ts'
import type { MachinesKey } from './locale.ts'
import { kindKey, type MachineStartup, type MachinesView, type RuntimeStatus, type StateLook, type Words } from './model.ts'

/** DSH's translate seat for this namespace: `{name}` placeholders take string values. */
export type Translate = (key: MachinesKey, params?: Record<string, string>) => string

/** A renderer-bound selector hook over one source. */
export type Hook<T> = <S>(selector: (snapshot: T) => S) => S

/** The props the DSH `main` slot renderer gives the Machines page. */
export interface MachinesPageProps extends Omit<MachinesFace, 'hooks'> {
  t: Translate
  useMachines: Hook<ReadState<MachinesView>>
  useStartups: Hook<Readonly<Record<string, MachineStartup>>>
  useRuntime: Hook<ReadState<RuntimeStatus>>
  useConnected: Hook<boolean>
}

export interface MachinesContext extends MachinesPageProps {
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
    return {
      ...props,
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
