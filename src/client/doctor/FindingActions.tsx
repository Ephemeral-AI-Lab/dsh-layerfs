/**
 * Buttons for a doctor finding's fixes (fixes.ts): Start a machine's worker,
 * Stop a machine, or Close a Sandbox, through the machines controller. Stop
 * and Close ask first; Close is forced, since a Sandbox with a dead daemon
 * cannot close cleanly. After a fix the page reads the findings again.
 */
import { useState, type ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useMachinesContext } from '../machines/context.tsx'
import { Refusal } from '../ui/index.tsx'
import type { FindingFix } from './fixes.ts'
import type { DoctorT } from './locale.ts'
import css from './Health.module.css'

export function FindingActions({ fixes, t, onDone }: { fixes: readonly FindingFix[], t: DoctorT, onDone: () => void }): ReactNode {
  const mc = useMachinesContext()
  const [asking, setAsking] = useState<FindingFix | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const machines = mc.useMachines((s) => (s.data?.available ? s.data.machines : null))
  const shown = fixes.filter((f) => f.kind !== 'start' || machines?.some((m) => m.name === f.name))
  if (!shown.length) return null
  const keyOf = (f: FindingFix) => `${f.kind}:${f.name}`
  const run = async (f: FindingFix) => {
    setBusy(keyOf(f)); setError(null)
    try {
      if (f.kind === 'start') await mc.act({ kind: 'start', name: f.name, platform: machines!.find((m) => m.name === f.name)!.platform })
      else if (f.kind === 'stop') await mc.act({ kind: 'stop', name: f.name })
      else await mc.closeSandbox(f.name, true)
      setAsking(null)
      onDone()
    } catch (e) { setError(e) } finally { setBusy(null) }
  }
  const label = (f: FindingFix) => t(f.kind === 'start' ? 'healthFixStart' : f.kind === 'stop' ? 'healthFixStop' : 'healthFixClose', { name: f.name })
  return (
    <div className={css.fixActions}>
      {shown.map((f) => (
        <Button key={keyOf(f)} size="sm" variant={f.kind === 'start' ? 'primary' : 'outline'} disabled={busy !== null}
          onClick={() => (f.kind === 'start' ? void run(f) : setAsking(f))}>
          {busy === keyOf(f) ? t('healthFixRunning') : label(f)}
        </Button>
      ))}
      {error != null && !asking ? <Refusal error={error} labels={mc.refusal} compact className={css.fixError} /> : null}
      {asking ? (
        <Modal open onClose={() => { if (busy === null) setAsking(null) }} closeLabel={t('healthFixCancel')}
          title={label(asking)}
          description={t(asking.kind === 'stop' ? 'healthFixStopBody' : 'healthFixCloseBody', { name: asking.name })}
          footer={(
            <>
              <Button variant="outline" disabled={busy !== null} onClick={() => setAsking(null)}>{t('healthFixCancel')}</Button>
              <Button variant="primary" disabled={busy !== null} onClick={() => void run(asking)}>{busy ? t('healthFixRunning') : t(asking.kind === 'stop' ? 'healthFixStopConfirm' : 'healthFixCloseConfirm')}</Button>
            </>
          )}>
          {error != null ? <Refusal error={error} labels={mc.refusal} /> : null}
        </Modal>
      ) : null}
    </div>
  )
}
