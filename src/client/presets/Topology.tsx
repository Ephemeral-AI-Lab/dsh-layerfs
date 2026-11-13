/**
 * The Studio library as one group per machine (each machine holds one store)
 * with its projects listed under it. Selecting a project shows its details;
 * each project row has a View script button. Rows show a status only while
 * a build runs or after it failed: a verified library needs no per-row
 * "Ready". The list is the plan, not a live inventory.
 */
import { useId, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconCloseOutlineRegular, IconCodeOutlineRegular, IconFolderOpenOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DemoPreset } from '../../shared/presets.ts'
import { MachinesGlyph } from '../machines/icons.tsx'
import type { PresetsKey, PresetsT } from './locale.ts'
import { count, elapsed, useClock } from './Progress.tsx'
import css from './presets.module.css'

/** A resource the script drawer can scope to. */
export interface PresetResource {
  readonly kind: 'machine' | 'store' | 'project'
  readonly name: string
  readonly machine: string
  readonly store?: string
}

export function PresetTopology({ preset, t, onCommands }: { preset: DemoPreset, t: PresetsT, onCommands: (resource: PresetResource) => void }): ReactNode {
  const [selected, setSelected] = useState<string>()
  const baseId = useId()
  /** The id of a project's details region, which its row button controls. */
  const detailsId = (name: string) => `${baseId}-details-${name.replace(/[^\w-]/g, '_')}`
  const job = preset.job
  const build = !!job?.rebuild
  const busy = job?.state === 'running' || job?.state === 'queued'
  const now = useClock(busy)
  const definitionOf = (name: string) => preset.projectDefinitions.find((p) => `${p.store}/${p.name}` === name)
  // Task records follow the latest Build; once the library verifies they are no longer news.
  const taskOf = (name: string) => build && !preset.contentReady ? job?.progress?.tasks?.find((task) => task.project === name) : undefined

  const statusOf = (name: string): { key: PresetsKey, tone?: 'running' | 'failed', title?: string } | null => {
    const task = taskOf(name)
    if (task) {
      if (task.state === 'running') return { key: 'statusRunning', tone: 'running' }
      if (task.state === 'completed') return busy ? { key: 'statusCreated', title: t('createdTitle') } : null
      if (task.state === 'failed') return { key: 'statusFailed', tone: 'failed', ...(task.error ? { title: task.error } : {}) }
      if (task.state === 'stopped') return { key: 'statusStopped', ...(task.error ? { title: task.error } : {}) }
      return { key: 'statusWaiting' }
    }
    return build && busy ? { key: 'statusWaiting' } : null
  }

  const machineLabel = (name: string) => name === 'native' ? t('native') : name === 'docker' ? t('docker') : name
  const machineSub = (name: string): string => {
    const info = preset.machineDefinitions.find((m) => m.name === name)
    const platform = info?.platform ?? name
    const kind = platform === 'native' ? t('localMachine') : platform === 'docker' ? t('container') : platform === 'lima' ? t('limaVm') : platform
    return info?.cpus ? `${kind} · ${t('resourcesValue', { cpus: info.cpus, memory: info.memory ?? '', disk: info.disk ?? '' })}` : kind
  }

  const details = (resource: PresetResource): ReactNode => {
    const definition = definitionOf(resource.name)
    const task = taskOf(resource.name)
    return (
      <section id={detailsId(resource.name)} className={css.details} aria-label={t('details')}>
        <div className={css.detailsHead}>
          <h4>{definition?.title ?? resource.name}</h4>
          <Button variant="ghost" size="sm" className={css.iconButton} aria-label={t('closeDetails')} icon={<IconCloseOutlineRegular size={14} />} onClick={() => setSelected(undefined)} />
        </div>
        {definition && <p className={css.muted}>{definition.description}</p>}
        {task && task.error && <p className={task.state === 'failed' ? css.error : css.muted}>{task.errorCode && <code>{task.errorCode}: </code>}{task.error}</p>}
        <dl className={css.facts}>
          <div><dt>{t('location')}</dt><dd>{t('locationValue', { store: resource.store ?? '', machine: machineLabel(resource.machine) })}</dd></div>
          {definition && (
            <>
              <div><dt>{t(preset.contentReady ? 'verifiedHistory' : 'plannedHistory')}</dt><dd>{t('historyValue', { commits: count(definition.history.commits), merges: count(definition.history.merges), layers: count(definition.layers ?? 0) })}</dd></div>
              <div><dt>{t('sideBranches')}</dt><dd>{count(definition.history.branches)}<details className={css.inlineDetails}><summary>{t('viewNames')}</summary>{definition.branches.join(', ')}</details></dd></div>
            </>
          )}
          {task && <><div><dt>{t('cliProgress')}</dt><dd>{t('cliProgressValue', { done: count(task.completed), total: count(task.total) })}</dd></div><div><dt>{t('elapsed')}</dt><dd>{elapsed(task.started, task.ended, now) || t('statusWaiting')}</dd></div></>}
        </dl>
      </section>
    )
  }

  const project = (resource: PresetResource, label: string): ReactNode => {
    const definition = definitionOf(resource.name)
    const task = taskOf(resource.name)
    const status = statusOf(resource.name)
    const isSelected = selected === resource.name
    const commits = definition ? (task ? `${count(task.commits ?? 0)} / ${count(definition.history.commits)}` : count(definition.history.commits)) : ''
    return (
      <>
        <div className={css.row}>
          <button type="button" className={css.select} aria-expanded={isSelected} aria-controls={detailsId(resource.name)} onClick={() => setSelected(isSelected ? undefined : resource.name)}>
            <span className={css.rowIcon} aria-hidden="true"><IconFolderOpenOutlineRegular size={15} /></span>
            <span className={css.rowText}>
              <span className={css.rowName}>{label}{definition && <span className={css.rowSub}>{definition.title}</span>}</span>
              {definition && (
                <span className={css.rowMeta}>
                  {t('projectLine', { commits, branches: count(definition.history.branches) })}{task?.started ? ` · ${elapsed(task.started, task.ended, now)}` : ''}
                </span>
              )}
            </span>
            {status && <span className={css.status} data-tone={status.tone} title={status.title}>{t(status.key)}</span>}
          </button>
          <Tooltip label={t('viewScriptFor', { name: label })} side="top" portal delayMs={400}>
            <Button variant="ghost" size="sm" className={clsx(css.rowAction, css.iconButton)} aria-label={t('viewScriptFor', { name: label })}
              icon={<IconCodeOutlineRegular size={14} />} onClick={() => onCommands(resource)} />
          </Tooltip>
        </div>
        {isSelected && details(resource)}
      </>
    )
  }

  return (
    <section className={css.topology} aria-label={t('library')}>
      {preset.machines.map((machine) => {
        const stores = preset.projectGroups.filter((g) => g.machine === machine)
        if (!stores.length) return null
        return (
          <div key={machine} className={css.group}>
            <div className={css.groupHead}>
              <span className={css.rowIcon} aria-hidden="true"><MachinesGlyph size={14} /></span>
              <span className={css.groupName}>{machineLabel(machine)}</span>
              <span className={css.groupSub}>{machineSub(machine)}</span>
              <span className={css.groupStore}>{stores.map((g) => [
                t(g.kind === 'postgresql' ? 'pgStoreLabel' : 'storeLabel', { store: g.store }),
                ...(g.attach?.length ? [t('pgAlsoAttached', { machines: g.attach.map(machineLabel).join(', ') })] : []),
              ].join(' · ')).join(' · ')}</span>
            </div>
            <ul className={css.tree}>
              {stores.flatMap((g) => g.projects.map((p) => (
                <li key={`${g.store}/${p}`}>{project({ kind: 'project', name: `${g.store}/${p}`, store: g.store, machine }, p)}</li>
              )))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}
