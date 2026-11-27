import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Checkbox, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { Contained, DangerButton, Field, Refusal, StatusDot, toneScope, type RefusalLabels } from './index.tsx'
import css from './ui.module.css'

export interface ConfirmForce {
  label: string
  action: string
}

export interface ConfirmLabels {
  cancel: string
  close: string
  typeToConfirm?: string | undefined
  refusal: RefusalLabels
}

export interface ConfirmDialogProps {
  open?: boolean
  onClose: () => void
  title: string
  body?: string | undefined
  action: string
  name?: string | undefined
  force?: ConfirmForce | undefined
  plain?: boolean | undefined
  steps?: readonly string[] | undefined
  actionFid?: string | undefined
  labels: ConfirmLabels
  run: (force: boolean) => Promise<unknown>
  children?: ReactNode
}

/** Shared confirmation dialog in its three forms: typed-name, plain, or red without a name. */
export function ConfirmDialog({
  open = true, onClose, title, body, action, name, force, plain, steps, actionFid, labels, run, children,
}: ConfirmDialogProps): ReactNode {
  const [typed, setTyped] = useState('')
  const [forced, setForced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(undefined)
  const on = !!force && forced
  const valid = !name || typed === name
  const hasBody = !!(steps?.length || name || force || children || error !== undefined)

  const go = async () => {
    if (!valid || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await run(on)
      onClose()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Contained>
      <Modal
        open={open}
        onClose={() => { if (!busy) onClose() }}
        title={title}
        description={body}
        closeLabel={labels.close}
        className={clsx(toneScope, css.confirmModal, busy && css.confirmModalBusy)}
        contentClassName={css.confirmContent}
        footer={(
          <div className={css.confirmFooter}>
            <Button variant="outline" disabled={busy} data-modal-autofocus={!name ? '' : undefined} onClick={onClose}>
              {labels.cancel}
            </Button>
            {plain ? (
              <Button
                variant="primary"
                disabled={!valid || busy}
                aria-busy={busy || undefined}
                data-fid={actionFid}
                icon={busy ? <StatusDot state="ongoing" size={13} /> : undefined}
                onClick={() => { void go() }}
              >
                {on ? force.action : action}
              </Button>
            ) : (
              <DangerButton
                disabled={!valid || busy}
                aria-busy={busy || undefined}
                data-fid={actionFid}
                icon={busy ? <StatusDot state="ongoing" size={13} /> : undefined}
                onClick={() => { void go() }}
              >
                {on ? force.action : action}
              </DangerButton>
            )}
          </div>
        )}
      >
        {hasBody ? (
          <form className={css.confirmForm} onSubmit={(e) => { e.preventDefault(); void go() }}>
            {steps?.length ? (
              <ol className={css.confirmSteps} data-steps={steps.length}>
                {steps.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
            ) : null}
            {children}
            {name ? (
              <Field label={labels.typeToConfirm ?? name}>
                <Input
                  className={css.confirmMono}
                  value={typed}
                  placeholder={name}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={labels.typeToConfirm ?? name}
                  data-modal-autofocus=""
                  onChange={(e) => setTyped(e.target.value)}
                />
              </Field>
            ) : null}
            {force ? <Checkbox checked={forced} disabled={busy} onChange={setForced} label={force.label} /> : null}
            {error !== undefined ? <Refusal error={error} labels={labels.refusal} /> : null}
            <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
          </form>
        ) : undefined}
      </Modal>
    </Contained>
  )
}
