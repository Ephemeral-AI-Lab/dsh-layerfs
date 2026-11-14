/**
 * Add a machine: one row per platform LayerFS knows on this computer
 * (machine.platforms, ssh and Firecracker left out by the host), each at its
 * step of the readiness ladder (needs.ts). Ready: a built-in (native, docker)
 * shows "Built in" with its machine's state, a VM shows Create and opens its
 * form in its row. Not ready: the step's tag and one button (Install, Set up,
 * Start, Get runtime) that opens what to do for this OS, commands to copy,
 * and Check again, which probes anew. Platforms this computer can never run
 * fold under "Not available on this computer" with the reason; when nothing
 * else is left (Windows today) the dialog says so plainly. The native row is
 * this computer, named for its OS. The dialog stays open while Create runs.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { CopyLine, Field, MenuSelect, Refusal } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import { MachineGlyph } from './icons.tsx'
import {
  blurbKey, declares, emptyVm, freeMachineName, parseSize, vmErrors, VM_KINDS,
  type AvailableView, type FormErrors, type MachinePlatformInfo, type VmForm,
} from './model.ts'
import { STEP_WORDS, nativeGlyphOs, nativeNameKey, osOfView, readinessOf, shortVersion, type HostOs, type Readiness } from './needs.ts'
import { FixPanel } from './Readiness.tsx'
import { MachineProgress, MachineStateChip, useInspect } from './parts.tsx'
import css from './machines.module.css'

export function AddMachineDialog({ view, platforms, onClose, onMade }: { view: AvailableView, platforms: MachinePlatformInfo[], onClose: () => void, onMade: (name: string) => void }): ReactNode {
  const { t, tw } = useMachinesContext()
  const [form, setForm] = useState<string | null>(null)
  const [help, setHelp] = useState<string | null>(null)
  const [away, setAway] = useState(false)
  const [busy, setBusy] = useState(false)
  const os = osOfView(view)
  const rows = platforms.map((p) => ({ p, r: readinessOf(p, os, view.layerfs) }))
  const here = rows.filter((x) => x.r.step !== 'unsupported')
  const elsewhere = rows.filter((x) => x.r.step === 'unsupported')
  const row = ({ p, r }: { p: MachinePlatformInfo, r: Readiness }) => (
    <PlatformRow key={p.platform} p={p} r={r} os={os} view={view} busy={busy}
      form={form === p.platform} onForm={(open) => setForm(open ? p.platform : null)}
      help={help === p.platform} onHelp={(open) => setHelp(open ? p.platform : null)}
      onBusy={setBusy} onMade={(name) => { setBusy(false); onClose(); onMade(name) }} />
  )
  return (
    <Modal open onClose={() => { if (!busy) onClose() }} title={t('addTitle')} description={t('addBody')} closeLabel={t('close')} className={css.wideDialog} contentClassName={css.dialogContent}>
      {platforms.length === 0
        ? <p className={css.muted}>{t('addNone')}</p>
        : here.length === 0
          ? <NoneHere os={os} />
          : <div className={css.platforms}>{here.map(row)}</div>}
      {elsewhere.length > 0 && (
        <div className={css.elsewhere}>
          <button type="button" className={css.elsewhereToggle} aria-expanded={away} onClick={() => setAway(!away)}>
            {away ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
            {t('unavailableHere', { n: String(elsewhere.length) })}
          </button>
          {away && (
            <div className={css.elsewhereList}>
              {elsewhere.map(({ p, r }) => (
                <div key={p.platform} className={css.platformRow} data-platform={p.platform}>
                  <span className={css.kindTile} aria-hidden="true"><MachineGlyph platform={p.platform} os={p.platform === 'native' ? nativeGlyphOs(os) : undefined} size={16} mono /></span>
                  <div className={css.platformText}>
                    <span className={css.platformName}><PlatformName platform={p.platform} os={os} /></span>
                    <span className={css.platformSub}>{r.fixes[0] ? tw(r.fixes[0].why) : null}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

/** A platform's name: the native machine is this computer (This Mac, This computer, This PC). */
function PlatformName({ platform, os }: { platform: string, os: HostOs }): ReactNode {
  const { t, kind } = useMachinesContext()
  return <>{platform === 'native' ? t(nativeNameKey(os)) : kind(platform)}</>
}

/** The native machine's line: the OS release, its architecture, and how its Sandboxes run. */
function nativeLine(view: AvailableView, os: HostOs, t: ReturnType<typeof useMachinesContext>['t']): string {
  const c = view.computer
  return [c?.name, c?.arch, t(os === 'linux' ? 'nativeSandboxed' : 'nativeUnisolated')].filter(Boolean).join(' · ')
}

function PlatformRow({ p, r, os, view, busy, form, onForm, help, onHelp, onBusy, onMade }: {
  p: MachinePlatformInfo, r: Readiness, os: HostOs, view: AvailableView, busy: boolean
  form: boolean, onForm: (open: boolean) => void, help: boolean, onHelp: (open: boolean) => void
  onBusy: (busy: boolean) => void, onMade: (name: string) => void
}): ReactNode {
  const { t, tw } = useMachinesContext()
  const blurb = blurbKey(p.platform)
  const ready = r.step === 'ready'
  const step = r.step === 'ready' || r.step === 'unsupported' ? null : STEP_WORDS[r.step]
  const sub = !ready
    ? r.fixes.filter((f) => f.step === r.step).map((f) => tw(f.why)).join(' · ')
    : p.platform === 'native'
      ? nativeLine(view, os, t)
      : [blurb ? t(blurb) : p.description || null, shortVersion(p.version) ?? t('ready')].filter(Boolean).join(' · ')
  return (
    <div className={css.platform} data-open={form || help || undefined} data-platform={p.platform} data-step={r.step}>
      <div className={css.platformRow}>
        <span className={css.kindTile} aria-hidden="true"><MachineGlyph platform={p.platform} os={p.platform === 'native' ? nativeGlyphOs(os) : undefined} size={16} /></span>
        <div className={css.platformText}>
          <span className={css.platformName}><PlatformName platform={p.platform} os={os} /></span>
          <span className={css.platformSub} title={ready ? p.version ?? p.description ?? undefined : undefined}>{sub}</span>
        </div>
        {ready && p.how !== 'created'
          ? <BuiltInMark view={view} platform={p.platform} />
          : ready
            ? <Button size="sm" variant={form ? 'ghost' : 'outline'} disabled={busy} aria-expanded={form} onClick={() => onForm(!form)}>{t('create')}</Button>
            : step && (
              <span className={css.platformMark}>
                <span className={css.tag}>{t(step.tag)}</span>
                <Button size="sm" variant="outline" aria-expanded={help} onClick={() => onHelp(!help)}>
                  {t(step.button)}<IconChevronDownOutlineRegular size={12} className={help ? css.flip : undefined} />
                </Button>
              </span>
            )}
      </div>
      {help && !ready && <FixPanel fixes={r.fixes} />}
      {form && ready && (VM_KINDS as readonly string[]).includes(p.platform) && (
        <VmForm kind={p.platform} view={view} onBusy={onBusy} onCancel={() => onForm(false)} onDone={onMade} />
      )}
    </div>
  )
}

/** Nothing can run on this computer (Windows today): say so, and where LayerFS does run. */
function NoneHere({ os }: { os: HostOs }): ReactNode {
  const { t } = useMachinesContext()
  const windows = os === 'windows'
  return (
    <div className={css.noneHere} role="status">
      <p className={css.platformName}>{t(windows ? 'noneHereTitle' : 'noneHereOtherTitle')}</p>
      <p>{t(windows ? 'noneHereBody' : 'noneHereOtherBody')}</p>
      {windows && <CopyLine text="wsl --install -d Ubuntu" copyLabel={t('copy')} copiedLabel={t('copied')} />}
      {windows && <a href="https://learn.microsoft.com/windows/wsl/install" target="_blank" rel="noreferrer" className={css.fixLink}>{t('wslGuide')}</a>}
    </div>
  )
}

/** A built-in platform's mark: nothing to create; its machine's state stands beside the badge. */
function BuiltInMark({ view, platform }: { view: AvailableView, platform: string }): ReactNode {
  const { t } = useMachinesContext()
  const m = view.machines.find((x) => x.platform === platform)
  return (
    <span className={css.platformMark}>
      <span className={css.tag}>{t('howBuiltIn')}</span>
      {m && <MachineStateChip m={m} live={view.status[m.name]} pending={null} />}
    </span>
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
