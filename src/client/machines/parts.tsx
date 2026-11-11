/**
 * What a machine's card and its page share: its state chip, Start or Stop,
 * the `…` menu (Open, power, Update settings… for the built-ins, Remove… for
 * VMs, refused while it holds Stores or Sandboxes), the settings and remove
 * dialogs, and the startup progress of a create or start.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconCheckOutlineRegular, IconChevronRightOutlineRegular, IconSettingsOutlineRegular, IconTrashOutlineRegular, IconWarningOutlineRegular, Input, MenuItemButton, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { Field, MoreMenu, Refusal, StateChip } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import type { MachineAction } from './controller.ts'
import { PowerGlyph } from './icons.tsx'
import { BUILT_IN, duration, heldWords, inUse, isImageRef, machineState, opWords, powerOf, stageWords, type MachineInfo, type MachineLive } from './model.ts'
import css from './machines.module.css'

/** Runs a machine action, one at a time: `pending` names it; LayerFS's refusal is kept to show. */
export type Run = (key: string, action: MachineAction) => Promise<boolean>

export function useMachineRun(): { run: Run, pending: string | null, error: unknown } {
  const { act } = useMachinesContext()
  const [error, setError] = useState<unknown>(null)
  const [pending, setPending] = useState<string | null>(null)
  const run: Run = async (key, action) => {
    setPending(key)
    setError(null)
    try {
      await act(action)
      return true
    } catch (e) {
      setError(e)
      return false
    } finally {
      setPending(null)
    }
  }
  return { run, pending, error }
}

/** The machine's state as the SDK gives it, or `Starting…` while a start runs here. */
export function MachineStateChip({ m, live, pending }: { m: MachineInfo, live?: MachineLive | undefined, pending: string | null }): ReactNode {
  const { t, stateWord } = useMachinesContext()
  if (pending === 'start') return <StateChip tone="warning" live label={t(m.platform === 'docker' ? 'startingWorker' : 'starting')} />
  const look = machineState(m, live)
  const op = opWords(look.op)
  return (
    <StateChip tone={look.tone} live={look.live} dashed={look.dashed} label={stateWord(look)} op={op}
      title={op ? t(look.op?.uncertain ? 'opTitleUncertain' : 'opTitle', { op }) : undefined} />
  )
}

/** The power words for a machine. */
function powerKey(m: MachineInfo, power: 'start' | 'stop') {
  return m.platform === 'docker' ? (power === 'stop' ? 'stopWorker' : 'startWorker') : (power === 'stop' ? 'stop' : 'start')
}

/** Start or Stop, when the machine is non-native and running or stopped. */
export function PowerButton({ m, pending, run, size = 'sm' }: { m: MachineInfo, pending: string | null, run: Run, size?: 'sm' | 'md' }): ReactNode {
  const { t } = useMachinesContext()
  const power = powerOf(m)
  const elapsed = useElapsed(pending === 'stop')
  if (!power) return null
  return (
    <Button size={size} variant={power === 'stop' ? 'outline' : 'primary'} disabled={pending !== null} icon={<PowerGlyph size={14} />}
      title={t(power === 'stop' ? 'powerRunningTitle' : 'powerStoppedTitle', { name: m.name })}
      onClick={(e) => { e.stopPropagation(); void run(power, power === 'start' ? { kind: 'start', name: m.name, platform: m.platform } : { kind: 'stop', name: m.name }) }}>
      {pending === 'start' ? t('starting') : pending === 'stop' ? t('stoppingFor', { s: String(elapsed) }) : t(powerKey(m, power))}
    </Button>
  )
}

/** Seconds since `on` became true. */
function useElapsed(on: boolean): number {
  const [since, setSince] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!on) { setSince(null); return }
    setSince(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return since === null ? 0 : Math.max(0, Math.round((now - since) / 1000))
}

/** The `…` menu: Open (on the board), power, Update settings… (built-ins) or Remove… (VMs). */
export function MachineMenu({ m, pending, run, onOpen, onDialog }: { m: MachineInfo, pending: string | null, run: Run, onOpen?: () => void, onDialog: (d: 'settings' | 'remove') => void }): ReactNode {
  const { t, tw } = useMachinesContext()
  const power = powerOf(m)
  const builtIn = BUILT_IN.has(m.platform)
  const held = inUse(m)
  return (
    <MoreMenu label={t('moreFor', { name: m.name })}>
      {(close) => (
        <>
          {onOpen && <MenuItemButton icon={<IconChevronRightOutlineRegular size={14} />} onSelect={() => { close(); onOpen() }}>{t('open')}</MenuItemButton>}
          {power && (
            <MenuItemButton icon={<PowerGlyph size={14} />} disabled={pending !== null}
              onSelect={() => { close(); void run(power, power === 'start' ? { kind: 'start', name: m.name, platform: m.platform } : { kind: 'stop', name: m.name }) }}>
              {t(powerKey(m, power))}
            </MenuItemButton>
          )}
          {builtIn
            ? (
              <>
                <MenuItemButton icon={<IconSettingsOutlineRegular size={14} />} onSelect={() => { close(); onDialog('settings') }}>{t('updateSettings')}</MenuItemButton>
                <MenuItemButton separatorBefore disabled disabledReason={t('builtInNoRemove')} icon={<IconTrashOutlineRegular size={14} />} onSelect={close}>{t('remove')}</MenuItemButton>
              </>
            )
            : (
              <MenuItemButton separatorBefore danger icon={<IconTrashOutlineRegular size={14} />} disabled={!!held || pending !== null}
                disabledReason={held ? tw(heldWords(held)) : undefined} onSelect={() => { close(); onDialog('remove') }}>
                {t('remove')}
              </MenuItemButton>
            )}
        </>
      )}
    </MoreMenu>
  )
}

/** The menu's dialogs: a built-in's settings, or removing a VM. */
export function MachineDialogs({ m, dialog, onClose, pending, run, onRemoved }: { m: MachineInfo, dialog: 'settings' | 'remove' | null, onClose: () => void, pending: string | null, run: Run, onRemoved?: () => void }): ReactNode {
  if (dialog === 'settings' && BUILT_IN.has(m.platform)) return <SettingsDialog m={m} onClose={onClose} pending={pending} run={run} />
  if (dialog === 'remove') return <RemoveDialog m={m} onClose={onClose} pending={pending} run={run} onRemoved={onRemoved} />
  return null
}

/** A built-in's settings (machine.update): its Sandbox image; docker also its socket and WSL distribution. */
function SettingsDialog({ m, onClose, pending, run }: { m: MachineInfo, onClose: () => void, pending: string | null, run: Run }): ReactNode {
  const { t, refusal } = useMachinesContext()
  const [image, setImage] = useState(m.image ?? '')
  const [socket, setSocket] = useState(m.docker ?? '')
  const [wsl, setWsl] = useState(m.wsl ?? '')
  const [error, setError] = useState<unknown>(null)
  const docker = m.platform === 'docker'
  const imageBad = image !== '' && !isImageRef(image)
  const save = async () => {
    if (imageBad || pending !== null) return
    setError(null)
    try {
      const ok = await run('update', { kind: 'update', name: m.name, changes: { image: image || undefined, ...(docker ? { docker: socket || undefined, wsl: wsl || undefined } : {}) } })
      if (ok) onClose()
    } catch (e) { setError(e) }
  }
  return (
    <Modal open onClose={onClose} title={t('settingsTitle')} description={m.name} closeLabel={t('close')} className={css.dialog}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={pending !== null || imageBad} onClick={() => void save()}>{pending === 'update' ? t('saving') : t('save')}</Button>
        </>
      )}>
      <form className={css.form} onSubmit={(e) => { e.preventDefault(); void save() }}>
        <Field label={t('sandboxImage')} error={imageBad ? t('errImage') : null}>
          <Input value={image} onChange={(e) => setImage(e.target.value)} placeholder="sha256:…" spellCheck={false} />
        </Field>
        {docker && (
          <Field label={t('dockerSocket')}>
            <Input value={socket} onChange={(e) => setSocket(e.target.value)} placeholder="/var/run/docker.sock" spellCheck={false} />
          </Field>
        )}
        {docker && m.wsl !== undefined && (
          <Field label={t('wslDistribution')}>
            <Input value={wsl} onChange={(e) => setWsl(e.target.value)} placeholder="Ubuntu-24.04" spellCheck={false} />
          </Field>
        )}
        {error != null && <Refusal error={error} labels={refusal} className={css.errorText} />}
      </form>
    </Modal>
  )
}

/** Remove a VM and its disk; LayerFS's refusal shows where it was asked. */
function RemoveDialog({ m, onClose, pending, run, onRemoved }: { m: MachineInfo, onClose: () => void, pending: string | null, run: Run, onRemoved?: () => void }): ReactNode {
  const { t } = useMachinesContext()
  return (
    <Modal open onClose={onClose} title={t('removeTitle', { name: m.name })} description={t('removeBody')} closeLabel={t('close')} className={css.dialog}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" className={css.danger} disabled={pending !== null}
            onClick={() => void run('remove', { kind: 'remove', name: m.name }).then((ok) => { onClose(); if (ok) onRemoved?.() })}>
            {pending === 'remove' ? t('removing') : t('remove')}
          </Button>
        </>
      )} />
  )
}

/**
 * A create or start as it was observed: the stage now, completed stages, the
 * elapsed time, and the reported error. Completion shows only after the call
 * answered; a lost reply says the outcome needs inspection.
 */
export function MachineProgress({ name, compact }: { name: string, compact?: boolean }): ReactNode {
  const { t, tw, useStartups, refusal } = useMachinesContext()
  const operation = useStartups((all) => all[name])
  const running = operation?.status === 'running'
  const [now, setNow] = useState(Date.now)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running, operation?.id])
  if (!operation) return null
  const { status, platform, stages } = operation
  const latest = stages.at(-1)
  const completed = stages.filter((s) => s.state === 'completed')
  const title = status === 'success' ? t('progressDone')
    : status === 'uncertain' ? t('progressUncertain')
      : status === 'failed' ? t('progressFailed')
        : operation.kind === 'create' ? t('progressCreating') : platform === 'docker' ? t('startingWorkerTitle') : t('startingMachine')
  const current = latest ? tw(stageWords(latest.stage, platform)) : t('progressPreparing')
  const elapsed = duration((operation.endedAt ?? now) - operation.startedAt)
  return (
    <section className={css.progress} data-compact={compact || undefined} data-status={status} aria-label={t('progressFor', { name })}>
      <div className={css.progressHead}>
        <span className={css.progressTitle} role="status" aria-live="polite">
          {running ? <StateDot state="ongoing" /> : status === 'success' ? <IconCheckOutlineRegular size={14} /> : <IconWarningOutlineRegular size={14} />}
          <span>{title}</span>
        </span>
        <span className={css.progressElapsed}>{elapsed}</span>
      </div>
      {status !== 'success' && (
        <p className={css.progressCurrent}>
          {current}{latest?.state === 'completed' ? ` · ${t('stageComplete')}` : latest?.state === 'failed' ? ` · ${t('stageFailed')}` : ''}
        </p>
      )}
      {status === 'uncertain' && <p className={css.progressNote}>{t('progressUncertainNote')}</p>}
      {status === 'failed' && <p className={css.progressNote}>{t('progressFailedNote')}</p>}
      {completed.length > 0 && !compact && (
        <>
          <button type="button" className={css.progressToggle} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <IconChevronRightOutlineRegular size={12} className={css.progressChevron} />
            {t(completed.length === 1 ? 'stepsOne' : 'stepsMany', { n: String(completed.length) })}
          </button>
          {open && (
            <ul className={css.progressSteps}>
              {completed.map((s) => (
                <li key={s.stage}>
                  <IconCheckOutlineRegular size={12} />
                  <span>{tw(stageWords(s.stage, platform))}</span>
                  {s.elapsedMs != null && <span className={css.progressElapsed}>{duration(s.elapsedMs)}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {(status === 'failed' || status === 'uncertain') && operation.error != null && !compact && <Refusal error={operation.error} labels={refusal} compact />}
    </section>
  )
}

/** "Observed 14:02: running" after an explicit inspect. */
export function useInspect(name: string): { inspection: string | null, inspect: () => Promise<void> } {
  const { t, inspectMachine } = useMachinesContext()
  const [inspection, setInspection] = useState<string | null>(null)
  const inspect = async () => {
    try {
      const answer = await inspectMachine(name)
      setInspection(t('observedAt', { time: new Date().toLocaleTimeString(), state: answer.state ?? t('stateUnknown') }))
    } catch (e) {
      setInspection(e instanceof Error ? e.message : String(e))
    }
  }
  return { inspection, inspect }
}

