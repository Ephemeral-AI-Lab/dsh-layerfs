/**
 * The folder row's tree (docs/specs/layerfs-setup.md §4.1): the LayerFS home
 * and the DSH x LayerFS home under the LayerFS folder, each with a short
 * summary, expanding to the folders it holds (`setup.contents`, one listing
 * per folder). Every line opens its folder (`setup.open {which, part}`: the
 * host opens only the listed names) and copies its path.
 *
 * A home line toggles on click; a folder line opens on click. Keys follow the
 * tree pattern: Enter or Space acts, Right opens a home, Left closes it.
 */
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button, IconCheckOutlineRegular, IconChevronRightOutlineRegular, IconCopyOutlineRegular, IconFolderOpenOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { copyText } from '../ui/index.tsx'
import { useQuery } from '../ui/use-query.ts'
import type { FolderContents, FolderEntry, FolderPart } from '../../shared/folder-parts.ts'
import type { SetupKey, SetupModalT } from './locale.ts'
import type { SetupStatus } from './store.ts'
import { countWords, relativeName } from './summary.ts'
import { LayerfsGlyph } from '../overview/glyph.tsx'
import { Whale } from '../views/marks.tsx'
import css from './setup.module.css'

type Home = 'home' | 'dsh'

const PART_KEY: Record<FolderPart, SetupKey> = {
  store: 'partStore', machine: 'partMachine', sandbox: 'partSandbox', runtime: 'partRuntime', backup: 'partBackup',
  log: 'partLog', trace: 'partTrace', sessions: 'partSessions', scratch: 'partScratch',
}

/** A folder's line: what it is (for machines, their names too). */
function partText(e: FolderEntry, which: Home, t: SetupModalT): string {
  const what = t(which === 'dsh' && e.name === 'trace' ? 'partCallOutputs' : PART_KEY[e.name])
  return e.name === 'machine' && e.count ? `${what} · ${e.names.join(', ')}${e.count > e.names.length ? ', …' : ''}` : what
}

/** A folder's count on the right: its entries (project conversations for sessions/), or Empty. */
function partCount(e: FolderEntry, t: SetupModalT, sessions: number | null): ReactNode {
  const n = e.name === 'sessions' ? sessions : e.count
  if (n == null) return null
  return n ? <span className={css.treeCount}>{n}</span> : <span className={css.treeCount} data-empty="">{t('partEmpty')}</span>
}

/** A home's chips: its Stores and machines, or its project conversations. */
function homeChips(which: Home, entries: readonly FolderEntry[] | undefined, t: SetupModalT, sessions: number | null): ReactNode {
  if (!entries) return null
  const count = (name: FolderPart) => entries.find((e) => e.name === name)?.count ?? 0
  const chips = which === 'home'
    ? [countWords(count('store'), t('storeOne'), t('storeMany')), countWords(count('machine'), t('machineOne'), t('machineMany'))]
    : sessions == null ? [] : [countWords(sessions, t('conversationOne'), t('conversationMany'))]
  return <span className={css.treeChips}>{chips.map((c) => <span key={c} className={css.treeChip}>{c}</span>)}</span>
}

export function FolderTree({ api, s, t, onError }: { api: LayerfsApi, s: SetupStatus, t: SetupModalT, onError: (e: unknown) => void }): ReactNode {
  const f = s.folder
  // reread with every setup check (Check again, a folder or runtime change); a remount draws the last answer at once
  const contents = useQuery(() => api.op<FolderContents>('setup.contents', {}), [api, f.path, f.dsh.path], { refresh: [s.at], cache: 'setup.contents' })
  const sessions = useQuery(() => api.op<{ project: number }>('sessions.count', {}).then((r) => r.project), [api], { refresh: [s.at], cache: 'sessions.count' })
  const [expanded, setExpanded] = useState<Record<Home, boolean>>({ home: false, dsh: false })
  const open = (which: Home, part?: FolderPart) => { api.op('setup.open', part ? { which, part } : { which }).catch(onError) }
  const n = sessions.data ?? null
  const homes: { which: Home, path: string, warn: boolean }[] = [
    { which: 'home', path: f.path, warn: f.state !== 'current' },
    { which: 'dsh', path: f.dsh.path, warn: false },
  ]
  return (
    <ul className={css.tree} role="tree" aria-label={t('folderTitle')}>
      {homes.map(({ which, path, warn }) => {
        const entries = contents.data?.[which]
        const isOpen = expanded[which] && !!entries?.length
        const toggle = (on = !expanded[which]) => setExpanded((x) => ({ ...x, [which]: on }))
        return (
          <li key={which} role="treeitem" aria-expanded={entries?.length ? isOpen : undefined} aria-label={relativeName(f.root, path)} className={css.treeNode} data-row={which}>
            <TreeLine name={relativeName(f.root, path)} line={t(which === 'home' ? 'folderHome' : 'folderDsh')}
              icon={which === 'home' ? <LayerfsGlyph size={16} /> : <Whale size={18} />}
              meta={homeChips(which, entries, t, n)} warn={warn} path={path} t={t}
              chevron={entries?.length ? (isOpen ? 'open' : 'closed') : 'none'}
              onActivate={() => (entries?.length ? toggle() : open(which))} onOpen={() => open(which)}
              onKey={(e) => { if (e.key === 'ArrowRight') toggle(true); else if (e.key === 'ArrowLeft') toggle(false) }} />
            {isOpen ? (
              <ul role="group" className={css.treeGroup}>
                {entries!.map((e) => (
                  <li key={e.name} role="treeitem" aria-label={`${e.name}/`} className={css.treeNode} data-part={e.name}>
                    <TreeLine name={`${e.name}/`} line={partText(e, which, t)} meta={partCount(e, t, n)} path={`${path}/${e.name}`} t={t} chevron="leaf"
                      onActivate={() => open(which, e.name)} onOpen={() => open(which, e.name)} onKey={(k) => { if (k.key === 'ArrowLeft') toggle(false) }} />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function TreeLine({ name, icon, line, meta, warn, path, chevron, onActivate, onOpen, onKey, t }: {
  name: string, icon?: ReactNode, line: string, meta?: ReactNode, warn?: boolean, path: string, chevron: 'open' | 'closed' | 'none' | 'leaf',
  onActivate: () => void, onOpen: () => void, onKey: (e: KeyboardEvent) => void, t: SetupModalT
}): ReactNode {
  const [copied, setCopied] = useState(false)
  const copy = () => { void copyText(path).then((r) => { if (r === 'copied') { setCopied(true); setTimeout(() => setCopied(false), 1000) } }) }
  return (
    <div className={css.treeLine} data-level={chevron === 'leaf' ? 'part' : 'home'} tabIndex={0} title={path}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('button')) onActivate() }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate() } else onKey(e)
      }}>
      <span className={css.treeChevron} data-state={chevron} aria-hidden="true">
        {chevron === 'open' || chevron === 'closed' ? <IconChevronRightOutlineRegular size={12} /> : null}
      </span>
      <span className={css.treeIcon} aria-hidden="true">{icon}</span>
      <span className={css.treeName}>{name}</span>
      <span className={css.treeText} data-warn={warn || undefined}>{line}</span>
      <span className={css.treeActions}>
        <Button variant="ghost" size="sm" className={css.treeButton} aria-label={copied ? t('copied') : t('copyPath')} title={copied ? t('copied') : t('copyPath')}
          icon={copied ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />} onClick={copy} />
        <Button variant="ghost" size="sm" className={css.treeButton} aria-label={t('openFolder')} title={t('openFolder')}
          icon={<IconFolderOpenOutlineRegular size={14} />} onClick={onOpen} />
      </span>
      <span className={css.treeMeta}>{meta}</span>
    </div>
  )
}
