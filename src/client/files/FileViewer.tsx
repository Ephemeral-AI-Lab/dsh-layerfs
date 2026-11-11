/** One saved file of a project Branch, read-only, line-numbered and highlighted. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, ReadBlock, languageForPath, type ReadBlockLabels, type DiffBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { filesApi } from './api.ts'
import { bytes } from './format.ts'
import { EmptyState, ErrorState, Loading } from './States.tsx'
import type { FileWindow, Translate } from './types.ts'
import { errorCode, useQuery } from './use-query.ts'
import css from './Files.module.css'

/** ReadBlock's and DiffBlock's localized chrome. */
export function codeLabels(t: Translate): ReadBlockLabels & DiffBlockLabels {
  return {
    codeLabel: t('files_code'),
    wrapLabel: t('files_wrap'),
    unwrapLabel: t('files_unwrap'),
    copy: t('files_copy'),
    copied: t('files_copied'),
    collapse: t('files_collapse'),
    collapseAria: t('files_collapseAria'),
    expand: (hidden: number) => t('files_expand', { count: hidden }),
    expandAria: (hidden: number) => t('files_expandAria', { count: hidden }),
    window: (shown: number, total: number) => t('files_window', { shown, total }),
  }
}

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
}

export function FileViewer({ api, project, branch, path, pin, t }: FileViewerProps): ReactNode {
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
