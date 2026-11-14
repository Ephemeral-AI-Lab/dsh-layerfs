/**
 * A machine's cached Sandbox images (docs/specs/sandbox-images.md §5.1.3,
 * Stage 1 only, not on macOS native): the Images section on its page (image,
 * size, who uses it, Remove on unused ones, total and free space) and the
 * Free space dialog (one checkbox per image, the unused ones preselected),
 * which New Sandbox and a create that failed for lack of space open on top of
 * themselves. Both read `GET /api/machines/<name>/sandbox-images` and remove
 * through `prune-images`; Docker's own copies are never touched.
 */
import { useState, type ReactNode } from 'react'
import { Button, Checkbox, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, Refusal, Section } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { useImageName, useRestartWorker, useSandboxImages } from './ImageMenu.tsx'
import { freeSpaceRows, freesWords, imagesFooter, imagesStatus, imagesTotal, removable, usedByWords } from './images.ts'
import { bytes, type MachineInfo, type PruneAnswer } from './model.ts'
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

/** The machine page's Images section: rendered only at Stage 1 and when the machine runs images (not macOS native). */
export function ImagesSection({ m }: { m: MachineInfo }): ReactNode {
  const { t, tw, refusal, pruneImages } = useMachinesContext()
  const images = useSandboxImages(m)
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
      <Section title={t('imagesTitle')} count={answer ? rows.length : undefined} className={css.imagesSection}
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
