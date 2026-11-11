/**
 * Add a machine: one row per platform this host creates (machine.platforms,
 * ssh and Firecracker left out by the host), with its tool's version or what
 * it misses. A ready platform opens its Create form in its row; a missing
 * tool shows how to install it. A form shows only the options its platform
 * declares and checks itself before it is sent. The dialog stays open while
 * Create runs.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconWarningOutlineRegular, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { CopyLine, Field, MenuSelect, Refusal } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { MachineGlyph } from './icons.tsx'
import {
  blurbKey, declares, emptyVm, freeMachineName, installHelp, needWords, parseSize, vmErrors, VM_KINDS,
  type AvailableView, type FormErrors, type MachinePlatformInfo, type VmForm,
} from './model.ts'
import { MachineProgress, useInspect } from './parts.tsx'
import css from './machines.module.css'

export function AddMachineDialog({ view, platforms, onClose, onMade }: { view: AvailableView, platforms: MachinePlatformInfo[], onClose: () => void, onMade: (name: string) => void }): ReactNode {
  const { t, tw, kind } = useMachinesContext()
  const [form, setForm] = useState<string | null>(null)
  const [help, setHelp] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <Modal open onClose={() => { if (!busy) onClose() }} title={t('addTitle')} description={t('addBody')} closeLabel={t('close')} className={css.wideDialog} contentClassName={css.dialogContent}>
      {platforms.length === 0
        ? <p className={css.muted}>{t('addNone')}</p>
        : (
          <div className={css.platforms}>
            {platforms.map((p) => {
              const tool = installHelp(p.missing, view.layerfs)
              const expanded = form === p.platform
              const blurb = blurbKey(p.platform)
              return (
                <div key={p.platform} className={css.platform} data-open={expanded || undefined}>
                  <div className={css.platformRow}>
                    <span className={css.kindTile} aria-hidden="true"><MachineGlyph platform={p.platform} size={16} /></span>
                    <div className={css.platformText}>
                      <span className={css.platformName}>{kind(p.platform)}</span>
                      {p.ready
                        ? <span className={css.platformSub} title={p.description || undefined}>{blurb ? `${t(blurb)} · ` : p.description ? `${p.description} · ` : ''}{p.version ?? t('ready')}</span>
                        : (
                          <span className={css.platformMissing}>
                            <IconWarningOutlineRegular size={12} aria-hidden="true" />
                            <span>{p.missing.map((n) => tw(needWords(n))).join(' · ')}</span>
                          </span>
                        )}
                    </div>
                    {p.ready
                      ? <Button size="sm" variant={expanded ? 'ghost' : 'outline'} disabled={busy} aria-expanded={expanded} onClick={() => setForm(expanded ? null : p.platform)}>{t('create')}</Button>
                      : tool
                        ? (
                          <Button size="sm" variant="ghost" aria-expanded={help === p.platform} onClick={() => setHelp(help === p.platform ? null : p.platform)}>
                            {t(tool.label)}<IconChevronDownOutlineRegular size={12} className={help === p.platform ? css.flip : undefined} />
                          </Button>
                        )
                        : null}
                  </div>
                  {!p.ready && tool && help === p.platform && (
                    <div className={css.platformHelp}>
                      <p>{tw(tool.words)}</p>
                      {tool.commands.map((line) => <CopyLine key={line} text={line} copyLabel={t('copy')} copiedLabel={t('copied')} />)}
                      <p className={css.muted}>{t('thenRefresh')}</p>
                    </div>
                  )}
                  {expanded && p.ready && (VM_KINDS as readonly string[]).includes(p.platform) && (
                    <VmForm kind={p.platform} view={view} onBusy={setBusy} onCancel={() => setForm(null)} onDone={(name) => { setBusy(false); onClose(); onMade(name) }} />
                  )}
                </div>
              )
            })}
          </div>
        )}
    </Modal>
  )
}

const say = (tw: (w: NonNullable<FormErrors[keyof VmForm]>) => string, errors: FormErrors, key: keyof VmForm): string | null => (errors[key] ? tw(errors[key]!) : null)

function VmForm({ kind, view, onBusy, onCancel, onDone }: { kind: string, view: AvailableView, onBusy: (busy: boolean) => void, onCancel: () => void, onDone: (name: string) => void }): ReactNode {
  const { t, tw, act, refusal, kind: kindLabel } = useMachinesContext()
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => { first.current?.focus() }, [])
  const has = (option: string) => declares(view.platforms, kind, option)
  const suggested = freeMachineName(kind, view.machines)
  const [f, setF] = useState<VmForm>(() => ({ ...emptyVm(), name: suggested }))
  const [imageMode, setImageMode] = useState<'default' | 'archive'>('default')
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [submitted, setSubmitted] = useState<string | null>(null)
  const { inspection, inspect } = useInspect(submitted ?? f.name.trim())
  const errors = vmErrors(f, view.machines, has('image') && imageMode === 'archive')
  const shown: FormErrors = tried ? errors : {}
  const set = (key: keyof VmForm) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [key]: e.target.value })

  const submit = async () => {
    setTried(true)
    if (busy || Object.keys(errors).length) return
    // Checked once: while it is made, the machine list holds its name, which is not a clash.
    setTried(false)
    const name = f.name.trim()
    setBusy(true); onBusy(true); setSubmitted(name); setError(null)
    const size = { ...(has('cpus') ? { cpus: Number(f.cpus) } : {}), ...(has('memory') ? { memory: parseSize(f.memory)! } : {}), ...(has('disk') ? { disk: parseSize(f.disk)! } : {}) }
    const image = has('image') && imageMode === 'archive' ? f.image.trim() : undefined
    try {
      await act({ kind: 'create', input: { platform: kind, name, ...size, ...(image ? { image } : {}) } })
      if (first.current?.isConnected) onDone(name)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false); onBusy(false)
    }
  }
  const code = (error as { code?: string, detail?: { vm_exists?: boolean } } | null)
  return (
    <form noValidate className={css.vmForm} onSubmit={(e) => { e.preventDefault(); void submit() }} aria-label={t('newKindMachine', { kind: kindLabel(kind) })}>
      <fieldset disabled={busy} className={css.fieldset}>
        <div className={css.vmGrid}>
          <Field label={t('name')} error={say(tw, shown, 'name')} className={css.vmName}>
            <Input ref={first} value={f.name} onChange={set('name')} placeholder={suggested} autoComplete="off" spellCheck={false} />
          </Field>
          {has('cpus') && <Field label={t('cpus')} error={say(tw, shown, 'cpus')}><Input value={f.cpus} onChange={set('cpus')} inputMode="numeric" /></Field>}
          {has('memory') && <Field label={t('memory')} error={say(tw, shown, 'memory')}><Input value={f.memory} onChange={set('memory')} /></Field>}
          {has('disk') && <Field label={t('disk')} error={say(tw, shown, 'disk')} hint={t('diskHint')}><Input value={f.disk} onChange={set('disk')} /></Field>}
        </div>
        {has('image') && (
          <div className={css.vmImage}>
            <Field label={t('sandboxImage')}>
              <MenuSelect label={t('sandboxImage')} value={imageMode} disabled={busy} onChange={setImageMode}
                options={[{ value: 'default', label: t('imageBundle') }, { value: 'archive', label: t('imageArchiveChoice') }]} />
            </Field>
            {imageMode === 'archive' && (
              <Field label={t('archivePathOrDigest')} error={say(tw, shown, 'image')}>
                <Input value={f.image} onChange={set('image')} placeholder="/path/to/sandbox-image.tar" spellCheck={false} />
              </Field>
            )}
          </div>
        )}
      </fieldset>
      {submitted && <MachineProgress name={submitted} />}
      {busy && <p className={css.muted}>{t('keepOpen')}</p>}
      {error !== null && (
        <div className={css.formActions}>
          <Button type="button" size="sm" variant="outline" onClick={() => void inspect()}>{t('inspectState')}</Button>
          {(code?.code === 'Unknown' || code?.detail?.vm_exists === true) && (
            <Button type="button" size="sm" variant="outline" onClick={() => { onCancel(); onDone(submitted ?? f.name.trim()) }}>{t('viewMachineRemoval')}</Button>
          )}
          {inspection && <p role="status" className={css.muted}>{inspection}</p>}
        </div>
      )}
      <div className={css.formActions}>
        <Button type="submit" size="sm" variant="primary" disabled={busy}>{busy ? t('creating') : t('create')}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
        {tried && Object.keys(errors).length > 0 && error === null && <span className={css.errorText}>{t('checkFields')}</span>}
      </div>
      {error !== null && <Refusal error={error} labels={refusal} className={css.errorText} />}
    </form>
  )
}
