/**
 * The CLI script of the library (or one resource of it): the real argument
 * lists in dependency order, 100 per page from a host snapshot that keeps
 * page order stable; input bodies expand on demand. Copy follows the page;
 * Download walks every page of the same snapshot.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconCheckOutlineRegular, IconCopyOutlineRegular, IconDownloadOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { q, type LayerfsApi } from '../api.ts'
import type { PresetExecutionMode, PresetScript, PresetScriptCommand } from '../../shared/presets.ts'
import { Loading, Refusal } from '../ui/index.tsx'
import type { PresetsT } from './locale.ts'
import type { PresetResource } from './Topology.tsx'
import { refusalLabels } from './labels.ts'
import css from './presets.module.css'

const PAGE = 100
const quote = (value: string) => /^[a-zA-Z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
const commandText = (argv: string[]) => ['layerfs', ...argv].map(quote).join(' ')
const execInput = (argv: string[]) => argv[0] === 'workspace' && argv[1] === 'exec' ? argv[3] : undefined
const displayCommand = (argv: string[]) => commandText(execInput(argv) === undefined ? argv : argv.map((value, i) => i === 3 ? '<shell command>' : value))

/** The plan as text: a dependency plan with exact stdin, not a standalone setup script. */
function planText(script: PresetScript, commands: PresetScriptCommand[]): string {
  const lines = [
    '# LayerFS CLI command plan (dsh-layerfs Presets). Build also prepares the sample source files.',
    '# This is a dependency plan, not a standalone shell script. Independent branch lanes can overlap;',
    '# each write/publish pair finishes before the next write on its branch.',
    '# <commit:step-key> is replaced at runtime by the immutable commit ID from that step\'s successful receipt.',
    `export LAYERFS_HOME=${quote(String(script.configuration.home ?? ''))}`,
  ]
  const cli = script.configuration.cli
  if (typeof cli === 'string' && cli.lastIndexOf('/') > 0) lines.push(`export PATH=${quote(cli.slice(0, cli.lastIndexOf('/')))}:"$PATH"`)
  if (script.dynamicReset) lines.push('# Cleanup targets are discovered again at runtime; this preview may not list every deletion.')
  const limits = script.configuration.historyLimits
  if (limits) lines.push(`# History CLI pool: at most ${limits.concurrency} commands, ${limits.perStore} per store, ${limits.perProject} per project.`)
  let phase = ''
  for (const step of commands) {
    if (step.phase !== phase) { phase = step.phase; lines.push('', `# ${phase.toUpperCase()}`) }
    if (step.note) lines.push(`# ${step.note}`)
    if (step.key) lines.push(`# Step ${step.key}${step.lane ? ` · lane ${step.lane}` : ''}${step.dependsOn?.length ? ` · after ${step.dependsOn.join(', ')}` : ''}`)
    if (step.commitFrom) lines.push(`# Commit argument: immutable commit returned by ${step.commitFrom}; never the moving branch head.`)
    const command = commandText(step.argv)
    // printf keeps stdin exact, including whether it ends with a newline.
    lines.push(step.input !== undefined ? `printf %s ${quote(step.input)} | ${command}` : command)
  }
  return `${lines.join('\n')}\n`
}

export function ScriptDrawer({ api, t, preset, sandboxes, executionMode, open, onClose, resource }: {
  api: LayerfsApi
  t: PresetsT
  preset: string
  sandboxes: boolean
  executionMode: PresetExecutionMode
  open: boolean
  onClose: () => void
  resource?: PresetResource | undefined
}): ReactNode {
  const [script, setScript] = useState<PresetScript>()
  const [error, setError] = useState<unknown>()
  const [copied, setCopied] = useState(false)
  const [filter, setFilter] = useState(true)
  const [offset, setOffset] = useState(0)
  const [downloading, setDownloading] = useState(false)
  const snapshot = useRef<{ key: string, id?: string }>({ key: '' })
  const scoped = !!resource && filter
  const key = `${preset}:${sandboxes}:${executionMode}:${scoped ? `${resource!.kind}:${resource!.name}` : 'all'}`
  const scope = scoped ? { kind: resource!.kind, name: resource!.name } : {}
  const path = (page: { offset: number, limit: number, snapshot?: string | undefined }) =>
    `/api/demo-presets/${preset}/${sandboxes ? 'script' : 'script-no-sandboxes'}${q({ ...page, ...scope, executionMode })}`

  useEffect(() => { if (open) { setFilter(true); setOffset(0); snapshot.current = { key: '' } } }, [open, resource?.kind, resource?.name])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setScript(undefined); setError(undefined); setCopied(false)
    if (snapshot.current.key !== key) { snapshot.current = { key }; if (offset) { setOffset(0); return } }
    api.call<PresetScript>('GET', path({ offset, limit: PAGE, snapshot: snapshot.current.id })).then((value) => {
      if (cancelled) return
      snapshot.current = { key, id: value.snapshot }
      setScript(value)
    }, (e: unknown) => { if (!cancelled) setError(e) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, open, key, offset])

  const commands = script?.commands ?? []
  const projectName = resource?.kind === 'project' ? resource.name.split('/').at(-1) : undefined
  const copy = async () => {
    if (!script) return
    try { await navigator.clipboard.writeText(planText(script, commands)); setCopied(true); setTimeout(() => setCopied(false), 1200) } catch { setError(new Error(t('copyUnavailable'))) }
  }
  const download = async () => {
    if (!script || downloading) return
    setDownloading(true); setError(undefined)
    try {
      const all: PresetScriptCommand[] = []
      for (let next: number | null = 0; next !== null;) {
        const page: PresetScript = await api.call('GET', path({ offset: next, limit: 1000, snapshot: script.snapshot }))
        all.push(...page.commands); next = page.next ?? null
      }
      const url = URL.createObjectURL(new Blob([planText(script, all)], { type: 'text/plain' }))
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = `${scoped && projectName ? projectName : preset}-cli-plan.txt`; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { setError(e) } finally { setDownloading(false) }
  }
  const phaseLabel = { reset: t('phaseReset'), build: t('phaseBuild'), verify: t('phaseVerify') }
  const title = scoped && projectName ? t('scriptTitleProject', { name: projectName }) : t('scriptTitleAll', { name: preset.charAt(0).toUpperCase() + preset.slice(1) })
  const limits = script?.configuration.historyLimits

  return (
    <Modal open={open} onClose={onClose} title={title} description={t(scoped ? 'scriptBodyProject' : 'scriptBodyAll')} closeLabel={t('close')} className={css.scriptModal} contentClassName={css.scriptBody}>
      {error !== undefined && <Refusal error={error} labels={refusalLabels(t)} />}
      {!script && error === undefined && <Loading label={t('loadingCommands')} />}
      {script && (
        <>
          <div className={css.scriptToolbar}>
            <span className={css.muted}>{commands.length ? t('commandRange', { from: offset + 1, to: offset + commands.length, total: script.total.toLocaleString() }) : t('commandRange', { from: 0, to: 0, total: script.total.toLocaleString() })}</span>
            <span className={css.grow} />
            <Button variant="ghost" size="sm" icon={copied ? <IconCheckOutlineRegular size={13} /> : <IconCopyOutlineRegular size={13} />} onClick={() => { void copy() }}>{t(copied ? 'copied' : 'copyPage')}</Button>
            <Button variant="ghost" size="sm" disabled={downloading} icon={<IconDownloadOutlineRegular size={13} />} onClick={() => { void download() }}>{t(downloading ? 'preparing' : 'downloadFull')}</Button>
          </div>
          {resource && (
            <div className={css.scriptFilter}>
              <span>{filter ? `${resource.kind}: ${resource.name}` : t('filterAll')}</span>
              <Button variant="ghost" size="sm" onClick={() => { setFilter((v) => !v); setOffset(0) }}>{t(filter ? 'showAll' : 'showRelated')}</Button>
            </div>
          )}
          <div className={css.commandList}>
            <p className={css.context}>{t('modeContext', { mode: t(executionMode === 'mixed' ? 'modeMixed' : 'modeFilesystem') })}<code>{String(script.configuration.home ?? '')}</code></p>
            {executionMode === 'mixed' && <p className={css.context}>{t('mixedContext')}</p>}
            {limits && <p className={css.context}>{t('poolContext', limits)}</p>}
            <p className={css.context}>{t('orderContext')}<code>{'<commit:step-key>'}</code>{t('commitContext')}</p>
            {!scoped && script.dynamicReset && <p className={css.context}>{t('dynamicReset')}</p>}
            {commands.map((step, i) => (
              <div key={offset + i}>
                {(i === 0 || commands[i - 1]!.phase !== step.phase) && <h3 className={css.phase}>{phaseLabel[step.phase]}</h3>}
                <div className={css.command}>
                  <span className={css.commandNumber}>{offset + i + 1}</span>
                  <div className={css.commandBody}>
                    {step.lane && <p className={css.lane}>{t('branchLane', { lane: step.lane })}</p>}
                    <code>{displayCommand(step.argv)}</code>
                    {execInput(step.argv) !== undefined && <details><summary>{t('execInput')}</summary><pre>{execInput(step.argv)}</pre></details>}
                    {step.note && <p>{step.note}</p>}
                    {step.commitFrom && <p>{t('publishes')}<code>{step.commitFrom}</code></p>}
                    {step.key && <details><summary>{t('stepDeps')}</summary><p>{t('step')}<code>{step.key}</code></p><p>{step.dependsOn?.length ? <>{t('after')}<code>{step.dependsOn.join(', ')}</code></> : t('noDeps')}</p></details>}
                    {step.input !== undefined && <details><summary>{t('stdin')}</summary><pre>{step.input}</pre></details>}
                  </div>
                </div>
              </div>
            ))}
            {!commands.length && <p className={css.context}>{t('noCommands')}</p>}
          </div>
          <div className={css.pagination}>
            <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t('previous')}</Button>
            <span className={css.muted}>{t('page', { n: Math.floor(offset / PAGE) + 1 })}</span>
            <Button variant="outline" size="sm" disabled={script.next == null} onClick={() => setOffset(script.next!)}>{t('next')}</Button>
          </div>
        </>
      )}
    </Modal>
  )
}
