/**
 * One saved file of a project Branch, read-only, in three views: Code (the
 * text, line-numbered and highlighted), Blame (the saved version that last
 * wrote each line) and History (the versions that changed this file, each
 * with its diff). Selecting a version in Blame opens it in History.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, ReadBlock, SegmentedControl, languageForPath } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { filesApi } from './api.ts'
import { FileBlame } from './FileBlame.tsx'
import { FileHistory } from './FileHistory.tsx'
import { bytes } from './format.ts'
import { codeLabels } from './labels.ts'
import { EmptyState, ErrorState, Loading } from './States.tsx'
import type { FileWindow, Translate } from './types.ts'
import { errorCode, useQuery } from './use-query.ts'
import css from './Files.module.css'

export { codeLabels } from './labels.ts'

/** The file views a viewer switches between. */
export type FileMode = 'code' | 'blame' | 'history'

export interface FileViewerProps {
  api: LayerfsApi
  /** The project key, `<store>/<project>`. */
  project: string
  branch: string
  /** Absolute path in the project. */
  path: string
  /** A saved Commit or Layer id; the Branch's saved head when omitted. */
  pin?: string | undefined
  t: Translate
  /** The view shown; the viewer keeps its own when the caller does not. */
  mode?: FileMode | undefined
  onModeChange?: ((mode: FileMode) => void) | undefined
}

export function FileViewer({ api, project, branch, path, pin, t, mode: controlled, onModeChange }: FileViewerProps): ReactNode {
  const [own, setOwn] = useState<FileMode>('code')
  const mode = controlled ?? own
  // The version Blame asked History to open.
  const [focus, setFocus] = useState<string | undefined>(undefined)
  const setMode = (next: FileMode) => { setOwn(next); onModeChange?.(next) }
  const options = [
    { value: 'code' as const, label: t('files_modeCode') },
    { value: 'blame' as const, label: t('files_modeBlame') },
    { value: 'history' as const, label: t('files_modeHistory') },
  ]
  const id = `files-mode-${path.replace(/[^\w-]/g, '_')}`
  return (
    <div className={css.fileView}>
      <div className={css.modeBar}>
        <SegmentedControl id={id} label={t('files_modeLabel')} value={mode} options={options}
          onChange={(next) => { if (next !== 'history') setFocus(undefined); setMode(next) }} />
      </div>
      <div className={css.modeBody} id={`${id}-${mode}-panel`} role="tabpanel">
        {mode === 'blame'
          ? <FileBlame api={api} project={project} branch={branch} path={path} pin={pin} t={t} onInspect={(version) => { setFocus(version); setMode('history') }} />
          : mode === 'history'
            ? <FileHistory key={focus ?? ''} api={api} project={project} branch={branch} path={path} pin={pin} t={t} focus={focus} />
            : <FileCode api={api} project={project} branch={branch} path={path} pin={pin} t={t} />}
      </div>
    </div>
  )
}

function FileCode({ api, project, branch, path, pin, t }: Omit<FileViewerProps, 'mode' | 'onModeChange'>): ReactNode {
  const first = useQuery(() => filesApi.file(api, project, branch, path, pin), [api, project, branch, path, pin])
  const [more, setMore] = useState<FileWindow[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  useEffect(() => { setMore([]) }, [first.data])
  if (first.error) {
    if (errorCode(first.error) === 'NoSuchPath') return <EmptyState title={t('files_absent')} />
    return <ErrorState title={t('files_readFailed', { what: path })} error={first.error} retryLabel={t('files_retry')} onRetry={first.reload} />
  }
  if (!first.data) return <Loading label={t('files_loading')} className={css.pad} />
  const file = first.data
  if (file.binary) return <EmptyState title={t('files_binary', { size: bytes(file.size) })} />
  const windows = [file, ...more]
  const text = windows.map((w) => w.text ?? '').join('')
  const lines = text.replace(/\n$/, '').split('\n').map((line, i) => ({ number: i + 1, text: line }))
  const next = windows.at(-1)?.next_line ?? null
  const loadMore = () => {
    if (next == null) return
    setLoadingMore(true)
    filesApi.file(api, project, branch, path, pin, next).then((w) => setMore((m) => [...m, w]), () => undefined).finally(() => setLoadingMore(false))
  }
  return (
    <div className={css.fileBody}>
      <ReadBlock className={css.readBlock} label={path} lines={lines} totalLines={lines.length} lang={languageForPath(path)} labels={codeLabels(t)} maxLines={Math.max(lines.length + 1, 16)} />
      {next != null ? (
        <div className={css.fileFoot}>
          <span>{t('files_windowNote', { shown: lines.length })}</span>
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={loadMore}>{t('files_moreLines')}</Button>
        </div>
      ) : null}
      {windows.some((w) => w.line_truncated) ? <p className={css.fileNote}>{t('files_lineClipped')}</p> : null}
    </div>
  )
}
