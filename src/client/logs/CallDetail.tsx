/**
 * One call in full, opened from a Logs row: the operation and outcome, the
 * whole command, the facts of the line, the session it belongs to, and what
 * it printed (`logs.output {tag}`, loaded when the detail opens). DSH's
 * primitives have no drawer or sheet, so this is the primitives `Modal`,
 * headless and sized large, with prev/next between the table's rows.
 */
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconCloseOutlineRegular, IconCopyOutlineRegular,
  Modal, Tag, fileSizeText, useClipboardCopy,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { OUTPUT_MAX, type CallLabel, type CallOutput, type LabeledLine, type LogsOutputAnswer } from '../../shared/logs.ts'
import { Card, Fact, Facts, LinkButton, Notice, Refusal, type RefusalLabels } from '../ui/index.tsx'
import { absoluteTime, commandParts, duration, jsonText, operationWords, readable } from './format.ts'
import { CommandWords } from './Command.tsx'
import type { LogsT } from './locale.ts'
import { checkpointWords, sessionParts } from './session-words.ts'
import css from './logs.module.css'

/** A Copy button with a one-second "Copied". */
export function CopyButton({ text, t, label }: { text: string, t: LogsT, label: string }): ReactNode {
  const { copied, onCopy } = useClipboardCopy(text)
  return (
    <Button variant="ghost" size="sm" className={css.copyButton} aria-label={copied ? t('copied') : label} title={label}
      icon={copied ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />} onClick={onCopy}>
      {copied ? t('copied') : t('copy')}
    </Button>
  )
}

/** OK in green, a refusal code as a red pill. */
export function OutcomeBadge({ outcome, t }: { outcome: string, t: LogsT }): ReactNode {
  return outcome === 'ok'
    ? <Tag tone="success">{t('outcomeOk')}</Tag>
    : <Tag tone="danger" className={css.codeTag}>{outcome}</Tag>
}

/** Whether a version is new, unchanged or referenced, from the line's kind and checkpoint. */
function versionWord(line: LabeledLine, t: LogsT): string {
  const c = line.dsh?.checkpoint
  if (c && (c.kind === 'restore' || c.kind === 'base')) return t('references')
  if (line.dsh?.match === 'commit') return t('references')
  if (line.kind && /uptodate|unchanged/i.test(line.kind)) return t('versionUnchanged')
  if (c && line.dsh?.match === 'tag' && !c.saved && c.changed === 0) return t('versionUnchanged')
  return t('versionCreated')
}

export interface DetailNav {
  index: number
  total: number
  prev?: (() => void) | undefined
  next?: (() => void) | undefined
}

/**
 * The call detail dialog.
 * @param props.line - the call; undefined closes the dialog.
 * @param props.onCalls - apply a tag filter to the page (a checkpoint's or session's calls).
 */
export function CallDetail({ api, t, line, nav, labels, onClose, onCalls }: {
  api: LayerfsApi
  t: LogsT
  line: LabeledLine | undefined
  nav: DetailNav
  labels: RefusalLabels
  onClose: () => void
  onCalls: (tag: string) => void
}): ReactNode {
  const op = line ? operationWords(line.argv) : ''
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    // Arrows scroll an output block that has focus.
    if ((e.target as HTMLElement).closest('pre, input, textarea, [role=menu]')) return
    const go = e.key === 'ArrowUp' ? nav.prev : nav.next
    if (!go) return
    e.preventDefault()
    go()
  }
  return (
    <Modal open={!!line} onClose={onClose} headless title={t('detailLabel', { op })} className={css.detailModal} onKeyDownCapture={onKey}>
      {line && (
        <>
          <header className={css.detailHead}>
            <div className={css.detailTitle}>
              <h2 className={css.detailOp}>{op}</h2>
              <OutcomeBadge outcome={line.outcome} t={t} />
            </div>
            <div className={css.detailNav}>
              {nav.total > 1 && <span className={css.muted}>{t('position', { i: nav.index + 1, n: nav.total })}</span>}
              <Button variant="ghost" size="sm" className={css.iconOnly} aria-label={t('prevCall')} title={`${t('prevCall')} (↑)`} disabled={!nav.prev}
                icon={<IconChevronUpOutlineRegular size={14} />} onClick={nav.prev} />
              <Button variant="ghost" size="sm" className={css.iconOnly} aria-label={t('nextCall')} title={`${t('nextCall')} (↓)`} disabled={!nav.next}
                icon={<IconChevronDownOutlineRegular size={14} />} onClick={nav.next} />
              <Button variant="ghost" size="sm" className={css.iconOnly} aria-label={t('close')} title={t('close')} data-modal-autofocus=""
                icon={<IconCloseOutlineRegular size={14} />} onClick={onClose} />
            </div>
          </header>
          <DetailBody key={`${line.at}|${line.tag ?? ''}|${line.argv.join('\u0000')}`} api={api} t={t} line={line} labels={labels} onCalls={onCalls} />
        </>
      )}
    </Modal>
  )
}

function DetailBody({ api, t, line, labels, onCalls }: { api: LayerfsApi, t: LogsT, line: LabeledLine, labels: RefusalLabels, onCalls: (tag: string) => void }): ReactNode {
  const parts = commandParts(line.argv)
  const version = line.commit ?? line.layer
  return (
    <div className={css.detailBody}>
      <section className={css.detailSection} aria-label={t('secCommand')}>
        <div className={css.sectionHead}>
          <h3 className={css.sectionTitle}>{t('secCommand')}</h3>
          <CopyButton text={parts.full} t={t} label={t('copyCommand')} />
        </div>
        <pre className={css.codeBlock} data-testid="logs-detail-command"><code><CommandWords parts={parts} /></code></pre>
      </section>

      <section className={css.detailSection} aria-label={t('secFacts')}>
        <h3 className={css.sectionTitle}>{t('secFacts')}</h3>
        <Card>
          <Facts label={t('secFacts')}>
            <Fact label={t('factStarted')}>{absoluteTime(line.at)}</Fact>
            <Fact label={t('factDuration')}>{line.ms >= 1000 ? `${duration(line.ms, t)} (${t('durMs', { n: line.ms })})` : duration(line.ms, t)}</Fact>
            <Fact label={t('factClient')} mono>{line.client}</Fact>
            <Fact label={t('factOutcome')}><OutcomeBadge outcome={line.outcome} t={t} /></Fact>
            <Fact label={t('factKind')} mono>{line.kind}</Fact>
            <Fact label={t('factVersion')}>
              {version && (
                <span className={css.factValue}>
                  <span className={css.muted}>{versionWord(line, t)}</span>
                  <code className={css.fullHex}>{version}</code>
                  <CopyButton text={version} t={t} label={t('copyVersion')} />
                </span>
              )}
            </Fact>
            <Fact label={t('factTag')}>
              {line.tag && (
                <span className={css.factValue}>
                  <code className={css.fullHex}>{line.tag}</code>
                  <CopyButton text={line.tag} t={t} label={t('copyTag')} />
                </span>
              )}
            </Fact>
            <Fact label={t('factSession')}>{line.dsh && <SessionFact t={t} label={line.dsh} />}</Fact>
          </Facts>
        </Card>
        {line.dsh && <SessionActions api={api} t={t} line={line} label={line.dsh} onCalls={onCalls} />}
      </section>

      <section className={css.detailSection} aria-label={t('secOutput')}>
        <h3 className={css.sectionTitle}>{t('secOutput')}</h3>
        <OutputSection api={api} t={t} line={line} labels={labels} />
      </section>
    </div>
  )
}

function SessionFact({ t, label }: { t: LogsT, label: CallLabel }): ReactNode {
  const name = label.title?.trim() || label.sessionId
  const words = sessionParts(label, t)
  return (
    <span className={css.sessionFact}>
      <span>{name}</span>
      {words.length > 0 && <span className={css.muted}>{words.join(' · ')}</span>}
    </span>
  )
}

function SessionActions({ api, t, line, label, onCalls }: { api: LayerfsApi, t: LogsT, line: LabeledLine, label: CallLabel, onCalls: (tag: string) => void }): ReactNode {
  const checkpoint = checkpointWords(label, t)
  return (
    <div className={css.detailActions}>
      <Button variant="outline" size="sm" onClick={() => api.openSession(label.sessionId)}>{t('openSessionAction')}</Button>
      {label.match === 'tag' && line.tag && (
        <LinkButton onClick={() => onCalls(line.tag!)}>{checkpoint ? t('callsCheckpoint') : t('callsReceipt')}</LinkButton>
      )}
      <LinkButton onClick={() => onCalls(`dsh:${label.sessionId}:`)}>{t('callsSession')}</LinkButton>
    </div>
  )
}

type OutputState = { state: 'loading' } | { state: 'done', answer: LogsOutputAnswer } | { state: 'error', error: unknown }

/** The stored output, read once per opened line. */
function OutputSection({ api, t, line, labels }: { api: LayerfsApi, t: LogsT, line: LabeledLine, labels: RefusalLabels }): ReactNode {
  const wanted = !!(line.output && line.tag)
  const [output, setOutput] = useState<OutputState>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!wanted) return
    let live = true
    setOutput({ state: 'loading' })
    api.op<LogsOutputAnswer>('logs.output', { tag: line.tag })
      .then((answer) => { if (live) setOutput({ state: 'done', answer }) })
      .catch((error: unknown) => { if (live) setOutput({ state: 'error', error }) })
    return () => { live = false }
  }, [api, line.tag, wanted, attempt])

  if (!wanted) return <OutputMissing t={t} />
  if (output.state === 'loading') return <p className={css.note} role="status">{t('outputLoading')}</p>
  if (output.state === 'error') {
    return (
      <div className={css.outputStack}>
        <Refusal error={output.error} labels={labels} compact />
        <div><Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>{t('retry')}</Button></div>
      </div>
    )
  }
  if ('missing' in output.answer) return <OutputMissing t={t} />
  return <OutputView t={t} output={output.answer} />
}

function OutputMissing({ t }: { t: LogsT }): ReactNode {
  return (
    <div className={css.outputMissing}>
      <p className={css.outputMissingTitle}>{t('outputMissingTitle')}</p>
      <p className={css.note}>{t('outputMissing')}</p>
    </div>
  )
}

function OutputView({ t, output }: { t: LogsT, output: CallOutput }): ReactNode {
  const stdout = output.stdout ?? ''
  const stderr = output.stderr ?? ''
  const exit = output.exit
  return (
    <div className={css.outputStack} data-testid="logs-detail-output">
      <div className={css.outputMeta}>
        {exit !== undefined && (
          <span className={css.metaItem}>
            <span className={css.muted}>{t('exitCode')}</span>
            {exit === null ? <Tag tone="danger">{t('exitSignal')}</Tag> : <Tag tone={exit === 0 ? 'neutral' : 'danger'} className={css.codeTag}>{String(exit)}</Tag>}
          </span>
        )}
        <span className={css.metaItem}><span className={css.muted}>stdout</span><span className={css.num}>{fileSizeText(output.bytes.stdout)}</span></span>
        <span className={css.metaItem}><span className={css.muted}>stderr</span><span className={css.num}>{fileSizeText(output.bytes.stderr)}</span></span>
      </div>
      {output.refusal && (
        <Notice tone="danger" className={css.refusalNotice}>
          <span className={css.refusalHead}>
            <Tag tone="danger" className={css.codeTag}>{output.refusal.code}</Tag>
            {output.refusal.message && <span>{output.refusal.message}</span>}
          </span>
          {output.refusal.detail != null && (
            <details className={css.disclosure}>
              <summary>{t('refusalDetail')}</summary>
              <pre className={css.codeBlock} tabIndex={0}>{jsonText(output.refusal.detail)}</pre>
            </details>
          )}
        </Notice>
      )}
      {stdout === '' && stderr === '' && !output.refusal && <p className={css.note}>{t('noOutput')}</p>}
      {stdout !== '' && <Stream t={t} name="stdout" text={stdout} total={output.bytes.stdout} truncated={!!output.truncated?.stdout} />}
      {stderr !== '' && <Stream t={t} name="stderr" text={stderr} total={output.bytes.stderr} truncated={!!output.truncated?.stderr} />}
    </div>
  )
}

function Stream({ t, name, text, total, truncated }: { t: LogsT, name: 'stdout' | 'stderr', text: string, total: number, truncated: boolean }): ReactNode {
  const shown = truncated ? { text, json: false } : readable(text)
  return (
    <div className={css.stream}>
      <div className={css.sectionHead}>
        <span className={css.streamName}>
          <span>{name}</span>
          {shown.json && <Tag tone="outline">JSON</Tag>}
        </span>
        <CopyButton text={text} t={t} label={t(name === 'stdout' ? 'copyStdout' : 'copyStderr')} />
      </div>
      <pre className={css.codeBlock} tabIndex={0} aria-label={name} data-stream={name}>{shown.text}</pre>
      {truncated && <p className={css.note}>{t(name === 'stdout' ? 'truncatedHead' : 'truncatedTail', { max: `${OUTPUT_MAX / 1024} KiB`, total: fileSizeText(total) })}</p>}
    </div>
  )
}
