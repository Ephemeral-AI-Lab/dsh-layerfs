/**
 * New Sandbox's Image menu (docs/specs/sandbox-images.md §5.1.1): the images
 * a Sandbox on this machine starts from at once ("On <machine>, ready"), one
 * row each, name and one tag; rows LayerFS cannot run are greyed with the
 * reason. At Stage 1 a second group lists this computer's Docker images
 * LayerFS can copy there ("From Docker on this Mac": size · copies once).
 * Digests, paths and Ids never show.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { SelectAnchor, refusalOf } from '../ui/index.tsx'
import { useQuery, type Query } from '../ui/use-query.ts'
import { useMachinesContext } from './context.tsx'
import { agoWords, displayRef, dockerTag, imagesFooter, imagesStatus, pickOf, reasonWords, type ImagePick } from './images.ts'
import { useMachineRun } from './parts.tsx'
import type { DockerImage, MachineInfo, ReadyImage, SandboxImagesView } from './model.ts'
import css from './machines.module.css'

export { defaultPick, findPick, imagePlan, phaseWords, type ImagePick } from './images.ts'

/** Events that change what a machine can start from settle this long before it is read again. */
const SETTLE_MS = 500
/** The row standing for "no image named": LayerFS's own default (no ready rows to offer). */
const LAYERFS_DEFAULT = '\u0000default'

/**
 * The machine's `sandbox-images` answer, kept under a cache key so a reopened
 * dialog draws at once. It reads again (never dropping a running read) when a
 * create on this machine ends, the machine starts or stops, Storage changes,
 * or the window regains focus.
 */
export function useSandboxImages(machine: Pick<MachineInfo, 'name' | 'state'>): Query<SandboxImagesView> {
  const { api, sandboxImages } = useMachinesContext()
  const [tick, setTick] = useState(0)
  const name = machine.name
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const bump = () => { timer ??= setTimeout(() => { timer = undefined; setTick((n) => n + 1) }, SETTLE_MS) }
    const offs = [
      api.onEvent('sandbox-progress', (e) => {
        const c = e.data?.creation
        if (c?.input?.machine === name && (c.phase === 'done' || c.phase === 'failed')) bump()
      }),
      api.onEvent('machine-progress', (e) => { if ((e.data?.name ?? e.data?.machine) === name) bump() }),
      api.onEvent('storage-changed', bump),
      // an image copy to this machine that ends changes both groups
      api.onEvent('image-load', (e) => {
        const l = e.data?.load
        if (l?.machine === name && (l.phase === 'done' || l.phase === 'failed')) bump()
      }),
    ]
    const focus = () => { if (document.visibilityState === 'visible') bump() }
    window.addEventListener('focus', focus)
    return () => { for (const off of offs) off(); window.removeEventListener('focus', focus); clearTimeout(timer) }
  }, [api, name])
  return useQuery(() => sandboxImages(name), [name], { cache: `machines:images:${name}`, refresh: [tick, machine.state] })
}

/** The Docker group's heading: "…on this Mac" on macOS, else "…on this computer". */
export const onMac = (): boolean => typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent || '')

/** A ready row's name: "LayerFS default" (in this locale) for the bundle's image, else its `:latest` ref or first ref. */
export function useImageName(): (row: Pick<ReadyImage, 'name' | 'refs' | 'source'>) => string {
  const { t } = useMachinesContext()
  return (row) => (row.source === 'bundle' ? t('imageLayerfsDefault') : row.name || displayRef(row.refs) || t('imageLayerfsDefault'))
}

/**
 * Restart worker for a machine whose worker is of another LayerFS build
 * (`stale.code` `WorkerOutdated`): the machine page's Stop, then Start (the
 * usual power actions: Start shows as the machine's startup), then the
 * images read again. `pending` is the step running.
 */
export function useRestartWorker(machine: Pick<MachineInfo, 'name' | 'platform'>, reread: () => void): { restart: () => Promise<void>, pending: string | null, error: unknown } {
  const { run, pending, error } = useMachineRun()
  const restart = async () => {
    try {
      if (await run('stop', { kind: 'stop', name: machine.name })) await run('start', { kind: 'start', name: machine.name, platform: machine.platform })
    } finally { reread() }
  }
  return { restart, pending, error }
}

/** The menu's footer row that restarts the worker. */
const RESTART = '\u0000restart'

/**
 * The menu. `value` is the picked row's id (null: LayerFS's default, no image
 * named); `onChange` gets the pick. It is disabled, saying so, while the
 * first answer loads.
 */
export function ImageMenu({ machine, images, value, onChange, disabled }: {
  machine: MachineInfo
  images: Query<SandboxImagesView>
  value: string | null
  onChange: (pick: ImagePick | null) => void
  disabled?: boolean
}): ReactNode {
  const { t, tw } = useMachinesContext()
  const nameOf = useImageName()
  const [open, setOpen] = useState(false)
  const answer = images.data
  const ready = answer?.ready ?? []
  const docker = answer?.docker?.available ? answer.docker.images : []
  const now = Date.now()
  const tagOf = (row: ReadyImage) => {
    if (!row.usable) return tw(reasonWords(row.reason))
    const ago = agoWords(row.lastUsed, now)
    return ago ? t('imageUsedAgo', { ago: tw(ago) }) : t('imageReadyTag')
  }
  const dockerTagOf = (row: DockerImage) => tw(dockerTag(row))
  const label = (name: string, tag: string, off: boolean, title?: string) => (
    <span className={css.imageItem} title={title}>
      <span className={css.imageName}>{name}</span>
      <span className={css.imageTag} data-off={off || undefined}>{tag}</span>
    </span>
  )
  const items: MenuEntry[] = [
    { type: 'label', id: '\u0000ready', text: t('imagesReadyOn', { machine: machine.name }) },
    ...(ready.length
      ? ready.map((row): MenuEntry => ({ id: row.id, disabled: !row.usable, label: label(nameOf(row), tagOf(row), !row.usable, row.refs.join('\n') || undefined) }))
      : [{ id: LAYERFS_DEFAULT, label: label(t('imageLayerfsDefault'), t('imageReadyTag'), false) }]),
    ...(docker.length
      ? [
          { type: 'label', id: '\u0000docker', text: t(onMac() ? 'imagesFromDockerMac' : 'imagesFromDockerHost') } as MenuEntry,
          ...docker.map((row): MenuEntry => ({ id: row.id, disabled: !row.usable, label: label(row.name, dockerTagOf(row), !row.usable, row.refs.join('\n') || undefined) })),
        ]
      : []),
  ]
  const restarting = useRestartWorker(machine, images.reload)
  const outdated = imagesStatus(answer, machine.state) === 'outdated'
  const footing = imagesFooter(answer, machine.state)
  const footer: MenuEntry[] | undefined = restarting.pending
    ? [{ type: 'label', id: '\u0000stale', text: t('restartingWorker') }]
    : footing
      ? [
          { type: 'label', id: '\u0000stale', text: tw(footing) },
          ...(restarting.error != null ? [{ type: 'label', id: '\u0000restartError', text: refusalOf(restarting.error).message } as MenuEntry] : []),
          ...(outdated ? [{ id: RESTART, label: t('restartWorker') } as MenuEntry] : []),
        ]
      : undefined
  const chosen = value ? ready.find((r) => r.id === value) : undefined
  const fromDocker = value && !chosen ? docker.find((r) => r.id === value) : undefined
  const selected = chosen ? chosen.id : fromDocker ? fromDocker.id : !ready.length ? LAYERFS_DEFAULT : undefined
  const loading = !answer && images.loading
  const shown = loading ? ''
    : chosen ? label(nameOf(chosen), tagOf(chosen), !chosen.usable)
      : fromDocker ? label(fromDocker.name, dockerTagOf(fromDocker), !fromDocker.usable)
        : !ready.length && answer ? label(t('imageLayerfsDefault'), t('imageReadyTag'), false) : ''
  return (
    <Menu open={open} onClose={() => setOpen(false)} portal autoFocus minWidthFromAnchor selection="check" selectedId={selected}
      items={items} footer={footer}
      onSelect={(id) => {
        setOpen(false)
        if (id === RESTART) { void restarting.restart(); return }
        const row = ready.find((r) => r.id === id)
        const copy = row ? undefined : docker.find((r) => r.id === id)
        onChange(row?.usable ? pickOf(row, 'ready') : copy?.usable ? pickOf(copy, 'docker') : null)
      }}
      anchor={(
        <SelectAnchor label={t('image')} value={shown} open={open} onToggle={setOpen} disabled={disabled || loading || !answer}
          placeholder={loading ? t('imagesLoading', { machine: machine.name }) : t('imageLayerfsDefault')}
          title={(chosen ?? fromDocker)?.refs.join('\n') || undefined} />
      )} />
  )
}
