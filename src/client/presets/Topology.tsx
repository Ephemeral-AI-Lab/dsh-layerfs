/**
 * The Studio library as a machine → store → project tree. Selecting a row
 * shows its details; each project has View script. Project status follows
 * the running build's task records; Ready needs a verified build of this
 * content version and mode. The tree is the plan, not a live inventory.
 */
import { useState, type ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular, IconDatabaseOutlineRegular, IconFolderOpenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DemoPreset } from '../../shared/presets.ts'
import { MachinesGlyph } from '../machines/icons.tsx'
import type { PresetsKey, PresetsT } from './locale.ts'
import { count, elapsed, useClock } from './Progress.tsx'
import css from './presets.module.css'

/** One row of the tree. */
export interface PresetResource {
  readonly kind: 'machine' | 'store' | 'project'
  readonly name: string
  readonly machine: string
  readonly store?: string
}

export function PresetTopology({ preset, t, onCommands }: { preset: DemoPreset, t: PresetsT, onCommands: (resource: PresetResource) => void }): ReactNode {
  const [selected, setSelected] = useState<PresetResource>()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const job = preset.job
  const build = !!job?.rebuild
  const busy = job?.state === 'running' || job?.state === 'queued'
  const now = useClock(busy)
  const groups = preset.projectGroups
  const verified = !!job && job.state === 'completed' && !!job.presetVerified && preset.contentReady
  const toggle = (key: string) => setCollapsed((previous) => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  const definitionOf = (name: string | undefined) => preset.projectDefinitions.find((p) => `${p.store}/${p.name}` === name)
  const taskOf = (name: string | undefined) => build ? job?.progress?.tasks?.find((task) => task.project === name) : undefined

  const statusOf = (resource: PresetResource): { key: PresetsKey, tone?: 'running' | 'failed', title?: string } => {
    if (verified) return { key: 'statusReady', title: t('readyTitle') }
    const task = resource.kind === 'project' ? taskOf(resource.name) : undefined
    if (task) {
      if (task.state === 'running') return { key: 'statusRunning', tone: 'running' }
      if (task.state === 'completed') return { key: 'statusCreated', title: t('createdTitle') }
      if (task.state === 'failed') return { key: 'statusFailed', tone: 'failed', title: task.error }
      if (task.state === 'stopped') return { key: 'statusStopped', title: task.error }
      return { key: 'statusWaiting' }
    }
    if (build && busy) return { key: 'statusWaiting' }
    return { key: 'statusPlanned' }
  }

  const details = (resource: PresetResource): ReactNode => {
    const definition = definitionOf(resource.name)
    const task = resource.kind === 'project' ? taskOf(resource.name) : undefined
    const group = groups.find((g) => g.store === resource.store)
    const machine = preset.machineDefinitions.find((m) => m.name === resource.machine)
    const kind = t(resource.kind === 'machine' ? 'kindMachine' : resource.kind === 'store' ? 'kindStore' : 'kindProject')
    return (
      <section className={css.details} aria-label={t('details')}>
        <div className={css.detailsHead}>
          <h4>{definition?.title ?? resource.name}</h4>
          <Button variant="ghost" size="sm" className={css.iconButton} aria-label={t('closeDetails')} icon={<IconCloseOutlineRegular size={14} />} onClick={() => setSelected(undefined)} />
        </div>
        {definition && <p className={css.muted}>{definition.description}</p>}
        {task && task.error && <p className={task.state === 'failed' ? css.error : css.muted}>{task.errorCode && <code>{task.errorCode}: </code>}{task.error}</p>}
        <dl className={css.facts}>
          <div><dt>{t('type')}</dt><dd>{kind}</dd></div>
          <div><dt>{t('machine')}</dt><dd>{resource.machine}</dd></div>
          {resource.kind === 'machine' && machine && <div><dt>{t('platform')}</dt><dd>{machine.platform}</dd></div>}
          {resource.kind === 'machine' && machine?.cpus && <div><dt>{t('resources')}</dt><dd>{t('resourcesValue', { cpus: machine.cpus, memory: machine.memory ?? '', disk: machine.disk ?? '' })}</dd></div>}
          {resource.kind === 'machine' && <div><dt>{t('storesOn')}</dt><dd>{groups.filter((g) => g.machine === resource.name).map((g) => g.store).join(', ') || t('none')}</dd></div>}
          {resource.kind === 'store' && <><div><dt>{t('location')}</dt><dd>{t('locationValue', { machine: resource.machine })}</dd></div><div><dt>{t('projects', { n: group?.projects.length ?? 0 })}</dt><dd>{group?.projects.join(', ')}</dd></div></>}
          {resource.kind === 'project' && <div><dt>{t('store')}</dt><dd>{resource.store}</dd></div>}
          {resource.kind === 'project' && definition && (
            <>
              <div><dt>{t('tier')}</dt><dd>{definition.tier}</dd></div>
              <div><dt>{t('sideBranches')}</dt><dd>{count(definition.history.branches)}<details className={css.inlineDetails}><summary>{t('viewNames')}</summary>{definition.branches.join(', ')}</details></dd></div>
              <div><dt>{t(preset.contentReady ? 'verifiedHistory' : 'plannedHistory')}</dt><dd>{t('historyValue', { commits: count(definition.history.commits), merges: count(definition.history.merges), layers: count(definition.layers ?? 0) })}</dd></div>
            </>
          )}
          {task && <><div><dt>{t('cliProgress')}</dt><dd>{t('cliProgressValue', { done: count(task.completed), total: count(task.total) })}</dd></div><div><dt>{t('elapsed')}</dt><dd>{elapsed(task.started, task.ended, now) || t('statusWaiting')}</dd></div></>}
        </dl>
        <Button variant="outline" size="sm" className={css.selfStart} onClick={() => onCommands(resource)}>{t('relatedCommands')}</Button>
      </section>
    )
  }

  const row = (resource: PresetResource, label: string, subtitle: string, expandable: boolean): ReactNode => {
    const key = `${resource.kind}:${resource.name}`
    const open = !collapsed.has(key)
    const definition = resource.kind === 'project' ? definitionOf(resource.name) : undefined
    const task = resource.kind === 'project' ? taskOf(resource.name) : undefined
    const status = statusOf(resource)
    const isSelected = selected?.kind === resource.kind && selected.name === resource.name
    const Icon = resource.kind === 'machine' ? <MachinesGlyph size={15} /> : resource.kind === 'store' ? <IconDatabaseOutlineRegular size={15} /> : <IconFolderOpenOutlineRegular size={15} />
    return (
      <>
        <div className={css.row} data-kind={resource.kind}>
          {expandable
            ? <button type="button" className={css.toggle} aria-label={t(open ? 'collapse' : 'expand', { name: label })} aria-expanded={open} onClick={() => toggle(key)}>
                {open ? <IconChevronDownOutlineRegular size={12} /> : <IconChevronRightOutlineRegular size={12} />}
              </button>
            : <span className={css.toggle} aria-hidden="true" />}
          <button type="button" className={css.select} aria-pressed={isSelected} onClick={() => setSelected(isSelected ? undefined : resource)}>
            <span className={css.rowIcon} aria-hidden="true">{Icon}</span>
            <span className={css.rowText}>
              <span className={css.rowName}>{label}<span className={css.rowSub}>{definition?.title ?? subtitle}</span></span>
              {definition && (
                <span className={css.rowMeta}>
                  {t('tierLine', {
                    tier: definition.tier ?? '',
                    commits: task ? `${count(task.commits ?? 0)} / ${count(definition.history.commits)}` : count(definition.history.commits),
                    layers: task ? `${count(task.layers ?? 1)} / ${count(definition.layers ?? 0)}` : count(definition.layers ?? 0),
                    branches: count(definition.history.branches),
                  })}{task?.started ? ` · ${elapsed(task.started, task.ended, now)}` : ''}
                </span>
              )}
            </span>
            <span className={css.status} data-tone={status.tone} title={status.title}>{t(status.key)}</span>
          </button>
          {resource.kind === 'project' && <Button variant="ghost" size="sm" className={css.rowAction} aria-label={t('viewScriptFor', { name: label })} onClick={() => onCommands(resource)}>{t('viewScript')}</Button>}
        </div>
        {isSelected && details(resource)}
      </>
    )
  }

  return (
    <section className={css.topology} aria-label={t('library')}>
      <div className={css.topologyHead}>
        <h3>{t('library')}</h3>
        <span className={css.muted}>{verified ? t('libraryVerified') : busy ? t(build ? 'libraryBuilding' : 'libraryResetting') : t('libraryHint')}</span>
      </div>
      <p className={css.note}>{t('plannedLoad', { n: preset.projects })}</p>
      {!preset.contentReady && preset.built && !busy && !(job && !job.rebuild && job.state === 'completed') && <p className={css.note}>{t('notVerified')}</p>}
      {busy && build && <p className={css.note}>{t('followRunning')}</p>}
      <ul className={css.tree}>
        {preset.machines.map((name) => {
          const info = preset.machineDefinitions.find((m) => m.name === name)
          const platform = info?.platform ?? name
          const stores = groups.filter((g) => g.machine === name)
          const machineLabel = name === 'native' ? t('native') : name === 'docker' ? t('docker') : name
          const sub = platform === 'native' ? t('localMachine') : platform === 'docker' ? t('container') : platform === 'lima' ? t('limaVm') : platform
          return (
            <li key={name}>
              {row({ kind: 'machine', name, machine: name }, machineLabel, sub, stores.length > 0)}
              {!collapsed.has(`machine:${name}`) && stores.length > 0 && (
                <ul>
                  {stores.map((g) => (
                    <li key={g.store}>
                      {row({ kind: 'store', name: g.store, store: g.store, machine: name }, g.store, t('sqliteStore'), true)}
                      {!collapsed.has(`store:${g.store}`) && (
                        <ul>{g.projects.map((p) => <li key={p}>{row({ kind: 'project', name: `${g.store}/${p}`, store: g.store, machine: name }, p, t('project'), false)}</li>)}</ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
