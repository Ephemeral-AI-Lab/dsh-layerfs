/**
 * A machine's cached Sandbox images (docs/specs/sandbox-images.md §5.1.3,
 * Stage 1 only, not on macOS native): the Images section on its page (image,
 * size, who uses it, Remove on unused ones, total and free space) and the
 * Free space dialog (one checkbox per image, the unused ones preselected),
 * which New Sandbox and a create that failed for lack of space open on top of
 * themselves. Both read `GET /api/machines/<name>/sandbox-images` and remove
 * through `prune-images`; Docker's own copies are never touched.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import { Card, Refusal, Section } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { onMac, useImageName, useRestartWorker, useSandboxImages } from './ImageMenu.tsx'
import { dockerRows, freeSpaceRows, freesWords, imagesFlow, imagesFooter, imagesStatus, imagesTotal, loadWords, phaseShare, reasonWords, removable, usedByWords } from './images.ts'
import { bytes, type DockerImage, type ImageLoad, type MachineInfo, type PruneAnswer, type SandboxImagesView } from './model.ts'
import type { Query } from '../ui/use-query.ts'
import css from './machines.module.css'

type MachineRef = Pick<MachineInfo, 'name' | 'state'>

/** LayerFS's refusals of single images, as lines under the list. */
function Refused({ refused, names }: { refused: PruneAnswer['refused'], names: Map<string, string> }): ReactNode {
  const { t } = useMachinesContext()
  if (!refused.length) return null
  return (
    <div role="alert" className={css.errorText}>
      {refused.map((r) => <p key={r.id}>{t('pruneRefused', { image: names.get(r.id) ?? r.id, message: r.message })}</p>)}
    </div>
  )
}

/**
 * The machine page's Images tab, read while it is open: a flow strip (this
 * computer's Docker, copied once, stored on the machine, used by Sandboxes),
 * the images stored on the machine, and the Docker images not on it yet, each
 * with Copy (machine.load in the background).
 */
export function ImagesTab({ m }: { m: MachineInfo }): ReactNode {
  const images = useSandboxImages(m)
  const answer = images.data
  if (answer && (answer.stage !== 1 || answer.mode === 'host')) return null
  return (
    <div className={css.tabStack}>
      {answer && <ImagesFlow m={m} answer={answer} />}
      <ImagesSection m={m} images={images} />
      {answer && <DockerSection m={m} images={images} />}
    </div>
  )
}

/** Three tiles: Docker on this computer (n, n can run here) → stored on the machine (n, size) → Sandboxes using them. */
function ImagesFlow({ m, answer }: { m: MachineInfo, answer: SandboxImagesView }): ReactNode {
  const { t } = useMachinesContext()
  const f = imagesFlow(answer)
  return (
    <div className={css.imgFlow} data-images-flow>
      <div className={css.imgFlowTile}>
        <span className={css.imgFlowLabel}>{t(onMac() ? 'imgFlowDockerMac' : 'imgFlowDockerHost')}</span>
        <span className={css.imgFlowValue}>{f.docker == null ? '—' : t(f.docker === 1 ? 'imgCountOne' : 'imgCount', { n: String(f.docker) })}</span>
        <span className={css.imgFlowNote}>{f.docker == null ? t('imgFlowDockerUnread') : t('imgFlowCanRun', { n: String(f.dockerUsable) })}</span>
      </div>
      <span className={css.imgFlowArrow} aria-hidden="true">{t('imgFlowCopyOnce')} →</span>
      <div className={css.imgFlowTile}>
        <span className={css.imgFlowLabel}>{t('imgFlowStored', { machine: m.name })}</span>
        <span className={css.imgFlowValue}>{t(f.stored === 1 ? 'imgCountOne' : 'imgCount', { n: String(f.stored) })}</span>
        <span className={css.imgFlowNote}>{answer.free != null ? t('imgFlowStoredFree', { size: bytes(f.storedBytes), free: bytes(answer.free) }) : bytes(f.storedBytes)}</span>
      </div>
      <span className={css.imgFlowArrow} aria-hidden="true">{t('imgFlowStarts')} →</span>
      <div className={css.imgFlowTile}>
        <span className={css.imgFlowLabel}>{t('imgFlowSandboxes')}</span>
        <span className={css.imgFlowValue}>{String(f.sandboxes)}</span>
        <span className={css.imgFlowNote}>{t('imgFlowUsing')}</span>
      </div>
    </div>
  )
}

/**
 * The image copies to `machine` the host runs (`GET /api/image-loads`, then
 * `image-load` events), keyed by image Id; `copy` admits one, `dismiss`
 * drops a failed one. A done copy leaves the map (the image is then stored).
 */
function useImageLoads(machine: string): { loads: Record<string, ImageLoad>, copy: (image: string) => Promise<void>, dismiss: (load: ImageLoad) => Promise<void> } {
  const { api } = useMachinesContext()
  const [loads, setLoads] = useState<Record<string, ImageLoad>>({})
  const put = (l: ImageLoad) => setLoads((now) => {
    const next = { ...now }
    if (l.phase === 'done') delete next[l.image]; else next[l.image] = l
    return next
  })
  useEffect(() => {
    let live = true
    setLoads({})
    void api.call<{ loads: ImageLoad[] }>('GET', '/api/image-loads').then((r) => {
      if (live) setLoads((now) => ({ ...Object.fromEntries((r?.loads ?? []).filter((l) => l.machine === machine).map((l) => [l.image, l])), ...now }))
    }).catch(() => {})
    const off = api.onEvent('image-load', (e) => { const l = e.data?.load as ImageLoad | undefined; if (live && l?.machine === machine) put(l) })
    return () => { live = false; off() }
  }, [api, machine])
  return {
    loads,
    copy: async (image) => { put((await api.call<{ load: ImageLoad }>('POST', `/api/machines/${encodeURIComponent(machine)}/load-image`, { image })).load) },
    dismiss: async (load) => {
      await api.call('DELETE', `/api/image-loads/${encodeURIComponent(load.id)}`)
      setLoads((now) => { const next = { ...now }; if (next[load.image]?.id === load.id) delete next[load.image]; return next })
    },
  }
}

/**
 * The Docker images not on the machine yet: search, Refresh, one row per
 * image with its size and the space a copy needs, and Copy to <machine>
 * (one attempt; a failure stays on its row with Dismiss). The ones that
 * cannot run here follow, with why. Copying needs a machine that answers
 * now; a stopped machine or an outdated worker shows the list without Copy.
 */
function DockerSection({ m, images }: { m: MachineInfo, images: Query<SandboxImagesView> }): ReactNode {
  const { t, tw, refusal } = useMachinesContext()
  const answer = images.data
  const [query, setQuery] = useState('')
  const [error, setError] = useState<unknown>(null)
  const { loads, copy, dismiss } = useImageLoads(m.name)
  if (!answer?.docker) return null
  const title = t(onMac() ? 'imgDockerTitleMac' : 'imgDockerTitleHost', { machine: m.name })
  if (!answer.docker.available) {
    return (
      <Card className={css.block}>
        <Section title={title} className={css.imagesSection}>
          <p className={css.muted}>{t(answer.docker.reason === 'not-installed' ? 'noteDockerMissing' : 'noteDockerOff', { machine: m.name })}</p>
        </Section>
      </Card>
    )
  }
  const canCopy = imagesStatus(answer, m.state) === 'fresh'
  const { usable, unusable, total } = dockerRows(answer, query)
  const start = async (id: string) => { setError(null); try { await copy(id) } catch (e) { setError(e) } }
  const row = (r: DockerImage) => {
    const load = loads[r.id]
    const share = load ? phaseShare({ phase: load.phase === 'queued' ? 'queued' : load.phase, done: load.done, total: load.total } as Parameters<typeof phaseShare>[0]) : null
    return (
      <tr key={r.id} data-docker-image={r.name} data-off={!r.usable || undefined}>
        <td className={css.imgName} title={[r.refs.join('\n'), r.id].filter(Boolean).join('\n')}><span className={css.mono}>{r.name}</span></td>
        <td className={css.imagesSize}>{bytes(r.size)}</td>
        <td className={r.usable && !r.fits ? css.imgWarn : css.muted}>
          {!r.usable ? <span className={css.imageTag} data-off>{tw(reasonWords(r.reason))}</span>
            : load ? <span className={load.phase === 'failed' ? css.errorText : undefined} role={load.phase === 'failed' ? 'alert' : undefined}>{tw(loadWords(load))}</span>
              : r.fits ? t('imgNeeds', { size: bytes(r.need) }) : t('imgNoFit', { size: bytes(r.need) })}
        </td>
        <td className={css.imgActionCol}>
          {r.usable && load && load.phase !== 'failed'
            ? <span className={css.imgBar} aria-hidden="true"><span style={{ width: `${Math.round((share ?? 0) * 100)}%` }} data-unknown={share == null || undefined} /></span>
            : r.usable && load?.phase === 'failed'
              ? <Button variant="ghost" size="sm" onClick={() => void dismiss(load).catch(setError)}>{t('imgDismiss')}</Button>
              : r.usable && canCopy && <Button variant="outline" size="sm" onClick={() => void start(r.id)} data-copy-image={r.name}>{t('imgCopyTo', { machine: m.name })}</Button>}
        </td>
      </tr>
    )
  }
  return (
    <Card className={css.block}>
      <Section title={title} count={answer.docker.images.filter((r) => r.usable).length} className={css.imagesSection}
        actions={(
          <span className={css.imgTools}>
            {total > 6 && <Input value={query} placeholder="postgres" aria-label={t('imgSearch')} className={css.imgSearch} onChange={(e) => setQuery(e.target.value)} />}
            <Button variant="ghost" size="sm" onClick={() => images.reload()}>{t('imgRefresh')}</Button>
          </span>
        )}>
        {total === 0
          ? <p className={css.muted}>{t('imgDockerEmpty', { machine: m.name })}</p>
          : usable.length + unusable.length === 0
            ? <p className={css.muted}>{t('imgNoMatch', { query })}</p>
            : (
              <table className={clsx(css.rows, css.imgTable)} aria-label={title}>
                <thead><tr><th className={css.imgName}>{t('imagesColImage')}</th><th className={css.imagesSize}>{t('imagesColSize')}</th><th>{t('imgColCopy')}</th><th className={css.imgActionCol} aria-label={t('imgColActions')} /></tr></thead>
                <tbody>{usable.map(row)}{unusable.map(row)}</tbody>
              </table>
            )}
        <div className={css.imagesFoot}>
          {!canCopy && <p>{t('imgCopyNeedsRunning', { machine: m.name })}</p>}
          <p>{t('imgBuildHint')}</p>
        </div>
        {error != null && <Refusal error={error} labels={refusal} compact className={css.errorText} />}
      </Section>
    </Card>
  )
}

/**
 * The machine page's Images section: the image copies stored on the machine
 * (each Sandbox names its own on its card), rendered only at Stage 1 and when
 * the machine runs images (not macOS native).
 */
export function ImagesSection({ m, images }: { m: MachineInfo, images: Query<SandboxImagesView> }): ReactNode {
  const { t, tw, refusal, pruneImages } = useMachinesContext()
  const nameOf = useImageName()
  const answer = images.data
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [refused, setRefused] = useState<PruneAnswer['refused']>([])
  const [freeing, setFreeing] = useState(false)
  const restarting = useRestartWorker(m, images.reload)
  if (answer && (answer.stage !== 1 || answer.mode === 'host')) return null
  const status = imagesStatus(answer, m.state)
  // removing needs a machine that answers now: not stopped, not an outdated worker, not a failed read
  const stopped = status !== 'fresh'
  const footing = status === 'failed' ? imagesFooter(answer, m.state) : null
  const rows = answer?.ready ?? []
  const names = new Map(rows.map((r) => [r.id, nameOf(r)]))
  const remove = async (id: string) => {
    setRemoving(id); setError(null); setRefused([])
    try { setRefused((await pruneImages(m.name, [id])).refused) } catch (e) { setError(e) } finally { setRemoving(null); images.reload() }
  }
  return (
    <Card className={css.block}>
      <Section title={t('imagesOnMachine', { machine: m.name })} count={answer ? rows.length : undefined} className={css.imagesSection}
        actions={answer && !stopped && rows.some(removable) ? <Button variant="outline" size="sm" onClick={() => setFreeing(true)}>{t('freeSpaceItem')}</Button> : undefined}>
        {!answer
          ? images.error != null
            ? <Refusal error={images.error} labels={refusal} compact className={css.errorText} />
            : <p className={css.muted}>{t('imagesLoading', { machine: m.name })}</p>
          : rows.length === 0
            ? status === 'outdated' ? null : <p className={css.muted}>{t('imagesEmpty', { machine: m.name })}</p>
            : (
              <table className={css.rows} aria-label={t('imagesTitle')}>
                <thead><tr><th>{t('imagesColImage')}</th><th className={css.imagesSize}>{t('imagesColSize')}</th><th>{t('imagesColUsedBy')}</th><th className={css.imagesAction} /></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td title={r.refs.join('\n') || undefined}>{names.get(r.id)}</td>
                      <td className={css.imagesSize}>{bytes(r.size)}</td>
                      <td className={r.sandboxes > 0 ? undefined : css.muted}>{tw(usedByWords(r.sandboxes))}</td>
                      <td className={css.imagesAction}>
                        {!stopped && removable(r) && r.sandboxes <= 0 && (
                          <Button variant="ghost" size="sm" disabled={removing !== null} onClick={() => void remove(r.id)}>
                            {removing === r.id ? t('imageRemoving') : t('imageRemove')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        {answer && (
          <div className={css.imagesFoot}>
            {rows.length > 0 && <p>{tw(imagesTotal(answer))}</p>}
            {status === 'outdated'
              ? (
                <div className={css.imagesOutdated} role="status">
                  <p>{t('imagesWorkerOutdated', { machine: m.name })}</p>
                  <Button variant="outline" size="sm" disabled={restarting.pending !== null} onClick={() => void restarting.restart()}>
                    {restarting.pending ? t('restartingWorker') : t('restartWorker')}
                  </Button>
                </div>
              )
              : <p>{status === 'stopped' ? t('imagesStoppedNote', { machine: m.name }) : footing ? tw(footing) : t('imagesNote')}</p>}
          </div>
        )}
        {restarting.error != null && <Refusal error={restarting.error} labels={refusal} compact className={css.errorText} />}
        {error != null && <Refusal error={error} labels={refusal} compact className={css.errorText} />}
        <Refused refused={refused} names={names} />
      </Section>
      {freeing && <FreeSpaceDialog machine={m} onClose={() => { setFreeing(false); images.reload() }} />}
    </Card>
  )
}

/**
 * Free space on a machine: one checkbox per removable image, the unused ones
 * preselected and the ones in use disabled. `need` (from New Sandbox, or a
 * create refused NoSpace) is said beside what the choice frees. `onClose`
 * says whether anything was removed.
 */
export function FreeSpaceDialog({ machine, need, onClose }: { machine: MachineRef, need?: number | null | undefined, onClose: (freed: boolean) => void }): ReactNode {
  const { t, tw, refusal, pruneImages } = useMachinesContext()
  const images = useSandboxImages(machine)
  const nameOf = useImageName()
  const { rows, preselected } = freeSpaceRows(images.data)
  // undefined: not touched yet, the unused images are checked
  const [picked, setPicked] = useState<string[] | undefined>(undefined)
  const checked = (picked ?? preselected).filter((id) => rows.some((r) => r.id === id && r.sandboxes <= 0))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [refused, setRefused] = useState<PruneAnswer['refused']>([])
  const [freed, setFreed] = useState(false)
  const names = new Map(rows.map((r) => [r.id, nameOf(r)]))
  const close = () => { if (!busy) onClose(freed) }
  const remove = async () => {
    setBusy(true); setError(null); setRefused([])
    try {
      const answer = await pruneImages(machine.name, checked)
      const any = freed || answer.removed.length > 0
      setFreed(any)
      setPicked(undefined)
      if (!answer.refused.length) { setBusy(false); onClose(any); return }
      setRefused(answer.refused)
      images.reload()
    } catch (e) { setError(e) }
    setBusy(false)
  }
  const toggle = (id: string, on: boolean) => setPicked((now) => {
    const base = (now ?? preselected).filter((x) => x !== id)
    return on ? [...base, id] : base
  })
  return (
    <Modal open onClose={close} title={t('freeSpaceTitle', { machine: machine.name })} description={t('freeSpaceBody')} closeLabel={t('close')}
      className={css.dialog} contentClassName={css.dialogContent}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy || checked.length === 0} onClick={() => void remove()}>
            {busy ? t('imageRemoving') : checked.length === 1 ? t('removeImagesOne') : t('removeImages', { n: String(checked.length) })}
          </Button>
        </>
      )}>
      <div className={css.form}>
        {!images.data
          ? images.error != null
            ? <Refusal error={images.error} labels={refusal} compact className={css.errorText} />
            : <p className={css.muted}>{t('imagesLoading', { machine: machine.name })}</p>
          : rows.length === 0
            ? <p className={css.muted}>{t('freeSpaceNone', { machine: machine.name })}</p>
            : (
              <ul className={css.freeList}>
                {rows.map((r) => {
                  const used = r.sandboxes > 0
                  return (
                    <li key={r.id} className={css.freeRow}>
                      <Checkbox checked={checked.includes(r.id)} disabled={busy || used} label={names.get(r.id) ?? r.id}
                        title={r.refs.join('\n') || undefined} onChange={(on) => toggle(r.id, on)} className={css.freeCheck} />
                      <span className={css.imageTag}>{bytes(r.size)}</span>
                      <span className={css.imageTag} data-off={used || undefined}>{used ? t('inUseBy', { n: String(r.sandboxes) }) : t('imagesUnused')}</span>
                    </li>
                  )
                })}
              </ul>
            )}
        {images.data && rows.length > 0 && <p className={css.muted}>{tw(freesWords(rows, checked, need))}</p>}
        {error != null && <Refusal error={error} labels={refusal} className={css.errorText} />}
        <Refused refused={refused} names={names} />
      </div>
    </Modal>
  )
}
