/**
 * What a Sandbox's tab and the machine pages share: reading a Sandbox
 * (sandbox.get), its menu (Delete is sandbox.close; Force delete is a separate
 * explicit action), and the New Sandbox dialog that creates one on a machine
 * from an eligible project.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconRightUpOutlineRegular, Input, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { Card, Field, MenuSelect, MoreMenu, Notice, Refusal, StateChip, type Choice } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { SandboxGlyph } from './icons.tsx'
import {
  BUILT_IN, SANDBOX_CAPACITY, SANDBOX_NAME, clearingCall, opWords, projectRef, shortImage, stateLook, workspaceChanges, workspaceName,
  type MachineImages, type MachineInfo, type MachineSandbox, type ProjectSummary, type SandboxInfo,
} from './model.ts'
import css from './machines.module.css'

const POLL_MS = 15_000

/** sandbox.get at mount, after its state or count changes, and every 15 s while it runs and the window is visible. */
export function useSandboxRead(name: string, state: string | undefined, count: number | null | undefined): { data: SandboxInfo | null, error: unknown, loading: boolean, reload: () => void } {
  const { readSandbox } = useMachinesContext()
  const [data, setData] = useState<SandboxInfo | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const reader = useRef(readSandbox)
  reader.current = readSandbox
  const read = useCallback(async () => {
    try { setData(await reader.current(name)); setError(null) } catch (e) { setError(e) } finally { setLoading(false) }
  }, [name])
  useEffect(() => { void read() }, [read, state, count])
  useEffect(() => {
    if (state !== 'running') return
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void read() }, POLL_MS)
    return () => clearInterval(timer)
  }, [read, state])
  return { data, error, loading, reload: () => void read() }
}

/** Normal close reconciles unknown results; explicit force bypasses worker reads. */
export function useClose(name: string): { busy: boolean, error: unknown, unknown: string[] | null, close: (force: boolean) => Promise<boolean>, forceAllowed: boolean, uncertain: boolean } {
  const { closeSandbox, readSandbox } = useMachinesContext()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [unknown, setUnknown] = useState<string[] | null>(null)
  const refusal = error as { code?: string, detail?: { execs?: unknown[] } } | null
  const close = async (force: boolean): Promise<boolean> => {
    setBusy(true)
    try {
      if (!force && refusal?.code === 'Unknown') { await readSandbox(name); setError(null); return false }
      setError(null)
      setUnknown(await closeSandbox(name, force))
      return true
    } catch (e) {
      setError(e)
      return false
    } finally {
      setBusy(false)
    }
  }
  const forceAllowed = refusal?.code === 'MountsActive' || (refusal?.code === 'Busy' && !!refusal.detail?.execs?.length)
  return { busy, error, unknown, close, forceAllowed, uncertain: refusal?.code === 'Unknown' }
}

/** Normal Delete, Read after uncertainty, and explicit Force delete. */
export function SandboxMenu({ name, op, closing, onOpen, onDeleted }: { name: string, op: MachineSandbox['op'], closing: ReturnType<typeof useClose>, onOpen?: () => void, onDeleted?: () => void }): ReactNode {
  const { t } = useMachinesContext()
  const { busy, close, uncertain } = closing
  const [confirm, setConfirm] = useState<'normal' | 'force' | null>(null)
  return (
    <>
      <MoreMenu label={t('moreForSandbox', { name })} disabled={busy}>
        {(dismiss) => (
          <>
            {onOpen && <MenuItemButton icon={<IconChevronRightOutlineRegular size={14} />} onSelect={() => { dismiss(); onOpen() }}>{t('open')}</MenuItemButton>}
            <MenuItemButton danger separatorBefore={!!onOpen} icon={<IconCloseOutlineRegular size={14} />} disabled={busy || (!!op && !op.uncertain)}
              onSelect={() => { dismiss(); if (uncertain) void close(false); else setConfirm('normal') }}>
              {uncertain ? t('readSandbox') : t('deleteSandbox')}
            </MenuItemButton>
            <MenuItemButton danger separatorBefore icon={<IconCloseOutlineRegular size={14} />} disabled={busy}
              onSelect={() => { dismiss(); setConfirm('force') }}>
              {t('forceDeleteSandbox')}
            </MenuItemButton>
          </>
        )}
      </MoreMenu>
      {confirm && (
        <Modal open onClose={() => { if (!busy) setConfirm(null) }} title={t(confirm === 'force' ? 'forceDeleteTitle' : 'deleteTitle')} closeLabel={t('close')} className={css.dialog}
          description={t(confirm === 'force' ? 'forceDeleteBody' : 'deleteBody', { name })}
          footer={(
            <>
              <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>{t('cancel')}</Button>
              <Button variant="primary" className={css.danger} disabled={busy}
                onClick={() => void close(confirm === 'force').then((ok) => { setConfirm(null); if (ok) onDeleted?.() })}>
                {busy ? t('deleting') : t(confirm === 'force' ? 'forceDeleteAction' : 'deleteAction')}
              </Button>
            </>
          )} />
      )}
    </>
  )
}

/** Sandbox image choice: the bundle default, an image from the machine's archive, or a caller-local archive. */
type SandboxImage = string | { archive: string, digest?: string } | undefined

function SandboxImageFields({ machine, disabled, onChange }: { machine: string, disabled: boolean, onChange: (image: SandboxImage, valid: boolean) => void }): ReactNode {
  const { t, machineImages, useMachines } = useMachinesContext()
  // what the pinned CLI has: an image inventory (machine.images) and caller-local archives (sandbox.create image_archive)
  const features = useMachines((snapshot) => (snapshot.data?.available ? snapshot.data.features : undefined))
  const archives = features?.imageArchive !== false
  const [inventory, setInventory] = useState<{ data: MachineImages | null, error: unknown, loading: boolean }>({ data: null, error: null, loading: true })
  const [choice, setChoice] = useState('')
  const [archive, setArchive] = useState('')
  const [digest, setDigest] = useState('')
  const inventoried = features?.images !== false
  const load = useCallback(() => {
    if (!inventoried) { setInventory({ data: { machine, mode: 'unsupported', default_digest: null, images: [] }, error: null, loading: false }); return }
    setInventory((v) => ({ ...v, loading: true, error: null }))
    machineImages(machine).then((data) => setInventory({ data, error: null, loading: false }), (error) => setInventory({ data: null, error, loading: false }))
  }, [machine, machineImages, inventoried])
  useEffect(() => { load() }, [load])
  const abs = (p: string) => /^(?:\/|[A-Za-z]:[\\/])/.test(p.trim()) && !p.includes('\0')
  const choose = (next: string, path = archive, pin = digest) => {
    setChoice(next)
    onChange(next === 'archive' ? { archive: path.trim(), ...(pin.trim() ? { digest: pin.trim() } : {}) } : next || undefined,
      next !== 'archive' || (abs(path) && (!pin.trim() || /^sha256:[a-f0-9]{64}$/.test(pin.trim()))))
  }
  if (inventory.data?.mode === 'host') return null
  // no inventory from this CLI: only the default image, and an archive when the CLI takes one
  const listed = inventory.data?.mode !== 'unsupported'
  if (!listed && !archives) return null
  const options: Choice<string>[] = [
    { value: 'default', label: t('imageDefault') },
    ...(inventory.data?.images ?? []).map((image) => ({ value: image.digest, label: `${image.title || image.tags.join(', ') || image.digest}${image.digest === inventory.data?.default_digest ? ` (${t('defaultWord')})` : ''}` })),
    ...(archives ? [{ value: 'archive', label: t('imageProvideArchive') }] : []),
  ]
  const errText = inventory.error ? (inventory.error as { message?: string }).message ?? String(inventory.error) : null
  return (
    <div className={css.form}>
      <Field label={t('sandboxImage')}
        hint={inventory.loading ? t('imagesLoading', { machine }) : errText ? t('imagesFailed', { message: errText }) : listed && inventory.data?.images.length === 0 ? t('imagesNone') : undefined}>
        <MenuSelect label={t('sandboxImage')} value={choice || 'default'} options={options} disabled={disabled} onChange={(v) => choose(v === 'default' ? '' : v)} />
      </Field>
      {errText && <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={load}>{t('imagesRetry')}</Button>}
      {choice === 'archive' && (
        <>
          <Field label={t('archivePath')} hint={t('archiveHint', { machine })} error={archive && !abs(archive) ? t('errAbsolute') : null}>
            <Input value={archive} onChange={(e) => { setArchive(e.target.value); choose(choice, e.target.value) }} placeholder="/absolute/path/to/sandbox-image.tar" disabled={disabled} spellCheck={false} />
          </Field>
          <Field label={t('digestOptional')} hint={t('digestHint')} error={digest && !/^sha256:[a-f0-9]{64}$/.test(digest.trim()) ? t('errDigest') : null}>
            <Input value={digest} onChange={(e) => { setDigest(e.target.value); choose(choice, archive, e.target.value) }} placeholder="sha256:…" disabled={disabled} spellCheck={false} />
          </Field>
        </>
      )}
    </div>
  )
}

/** New Sandbox on this machine: SQLite projects whose Store is here, or PostgreSQL projects when the machine supports them. */
export function NewSandboxDialog({ machine, taken, onClose }: { machine: MachineInfo, taken: string[], onClose: () => void }): ReactNode {
  const { t, projects: readProjects, createSandbox, readSandbox, refusal, openStorageTab } = useMachinesContext()
  const [projects, setProjects] = useState<{ data: ProjectSummary[] | null, error: unknown, loading: boolean }>({ data: null, error: null, loading: true })
  const loadProjects = useCallback(() => {
    setProjects({ data: null, error: null, loading: true })
    readProjects().then((data) => setProjects({ data, error: null, loading: false }), (error) => setProjects({ data: null, error, loading: false }))
  }, [readProjects])
  useEffect(() => { loadProjects() }, [loadProjects])
  const eligible = (projects.data ?? []).filter((p) => (p.kind === 'sqlite' ? p.machine === machine.name && machine.supports?.sqlite !== false : p.kind === 'postgresql' && machine.supports?.postgresql_sandbox === true))
  const [project, setProject] = useState('')
  const [name, setName] = useState('')
  const [image, setImage] = useState<SandboxImage>()
  const [imageValid, setImageValid] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [observation, setObservation] = useState('')
  const uncertain = (error as { code?: string } | null)?.code === 'Unknown'
  const choose = (key: string) => {
    setProject(key)
    const stem = (eligible.find((p) => p.key === key)?.name ?? 'sandbox').replace(/[^a-z0-9_.-]/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 50) || 'sandbox'
    for (let n = 1; ; n++) if (!taken.includes(`${stem}-${n}`)) { setName(`${stem}-${n}`); break }
    setError(null)
  }
  const valid = SANDBOX_NAME.test(name) && !BUILT_IN.has(name) && !taken.includes(name)
  const ready = !busy && !uncertain && valid && imageValid && eligible.some((p) => p.key === project)
  const make = async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await createSandbox(project, { name, machine: machine.name, ...(image ? { image } : {}) })
      onClose()
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return (
    <Modal open onClose={() => { if (!busy) onClose() }} title={t('newSandbox')} description={t('newSandboxBody', { machine: machine.name })} closeLabel={t('close')} className={css.dialog} contentClassName={css.dialogContent}
      footer={(
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void make()}>{busy ? t('creating') : t('createSandbox')}</Button>
        </>
      )}>
      <form className={css.form} onSubmit={(e) => { e.preventDefault(); void make() }}>
        {projects.error != null
          ? (
            <>
              <Refusal error={projects.error} labels={refusal} className={css.errorText} />
              <div><Button type="button" size="sm" variant="outline" onClick={loadProjects}>{t('retryProjects')}</Button></div>
            </>
          )
          : projects.loading
            ? <p role="status" className={css.muted}>{t('projectsLoading')}</p>
            : eligible.length === 0
              ? (
                <>
                  <p role="status" className={css.muted}>{t('projectsNone', { machine: machine.name })}</p>
                  <div><Button type="button" size="sm" variant="outline" icon={<IconRightUpOutlineRegular size={13} />} onClick={() => { onClose(); openStorageTab('overview') }}>{t('openStorage')}</Button></div>
                </>
              )
              : (
                <>
                  <Field label={t('project')}>
                    <MenuSelect label={t('project')} value={project} placeholder={t('chooseProject')} disabled={busy || uncertain}
                      options={eligible.map((p) => ({ value: p.key, label: p.key }))} onChange={choose} />
                  </Field>
                  <Field label={t('name')} hint={t('sandboxNameHint')} error={name && !valid ? t('errSandboxName') : null}>
                    <Input value={name} onChange={(e) => setName(e.target.value)} disabled={busy || uncertain} spellCheck={false} maxLength={63} />
                  </Field>
                  <SandboxImageFields key={machine.name} machine={machine.name} disabled={busy || uncertain} onChange={(value, ok) => { setImage(value); setImageValid(ok) }} />
                  <p className={css.muted}>{t('machineIs', { machine: machine.name })}</p>
                </>
              )}
        {error != null && <Refusal error={error} labels={refusal} className={css.errorText} />}
        {uncertain && (
          <Notice>
            <p>{t('createUncertain')}</p>
            <div>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={async () => {
                setBusy(true)
                try { const current = await readSandbox(name); setObservation(t('sandboxStateIs', { state: current.state ?? t('stateUnknown') })) } catch (e) { setObservation(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
              }}>{t('readSandbox')}</Button>
            </div>
            {observation && <p role="status">{observation}</p>}
          </Notice>
        )}
      </form>
    </Modal>
  )
}
