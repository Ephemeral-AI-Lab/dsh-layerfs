/**
 * A platform's fixes as the page shows them (needs.ts): FixPanel, what to do
 * for each need with commands to copy and Check again; and Blocked, the line
 * a machine block shows when its platform stopped being ready here (Docker
 * quit, Lima removed): why it cannot run now and the one step that fixes it,
 * in place of a Start that would only fail.
 */
import { useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { CopyLine } from '../ui/index.tsx'
import { useMachinesContext } from './context.tsx'
import type { MachineInfo } from './model.ts'
import { STEP_WORDS, stepReasons, type Fix, type Readiness } from './needs.ts'
import css from './machines.module.css'

const URL_LINE = /^https?:\/\//

/** What to do for each need, in ladder order, then Check again (a fresh probe). */
export function FixPanel({ fixes, className }: { fixes: Fix[], className?: string | undefined }): ReactNode {
  const { t, tw, recheck } = useMachinesContext()
  const [checking, setChecking] = useState(false)
  const shown = fixes.filter((f) => f.step !== 'unsupported')
  return (
    <div className={className ?? css.platformHelp}>
      {shown.map((f) => (
        <div key={f.need} className={css.fixStep}>
          <p>{f.how ? tw(f.how) : tw(f.why)}</p>
          {f.commands.map((line) => URL_LINE.test(line)
            ? <a key={line} href={line} target="_blank" rel="noreferrer" className={css.fixLink}>{line}</a>
            : <CopyLine key={line} text={line} copyLabel={t('copy')} copiedLabel={t('copied')} />)}
        </div>
      ))}
      <Button size="sm" variant="outline" disabled={checking} onClick={() => { setChecking(true); void recheck().finally(() => setChecking(false)) }}>
        {checking ? t('checking') : t('checkAgain')}
      </Button>
    </div>
  )
}

/** Why `m` cannot run now (its platform is not ready here) and the step that fixes it. */
export function Blocked({ m, block }: { m: MachineInfo, block: Readiness }): ReactNode {
  const { t, tw, kind } = useMachinesContext()
  const [open, setOpen] = useState(false)
  const step = block.step === 'ready' || block.step === 'unsupported' ? null : STEP_WORDS[block.step]
  const reason = stepReasons(block, tw)
  return (
    <div className={css.blocked} data-step={block.step}>
      <div className={css.blockedLine}>
        <span className={css.blockReasonText} title={reason}>{t('unavailableWhy', { kind: kind(m.platform), reason })}</span>
        {step && (
          <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
            {t(step.button)}<IconChevronDownOutlineRegular size={12} className={open ? css.flip : undefined} />
          </Button>
        )}
      </div>
      {open && <FixPanel fixes={block.fixes} className={css.blockedHelp} />}
    </div>
  )
}
