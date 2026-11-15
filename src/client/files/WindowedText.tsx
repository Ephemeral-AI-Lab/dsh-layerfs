/**
 * A text read one window at a time: the first window, line-numbered and
 * highlighted, and "more lines" for the next. The caller's `read` decides how
 * a window is addressed (a project file by line, a machine or Sandbox file by
 * byte offset); a window may end anywhere, mid-line included, since the
 * windows are joined before the lines are numbered.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, ReadBlock, languageForPath } from '@deepseek-ai/dsh-client-ui-primitives'
import { bytes } from './format.ts'
import { codeLabels } from './labels.ts'
import { EmptyState, ErrorState, Loading } from './States.tsx'
import type { Translate } from './types.ts'
import { errorCode, useQuery } from './use-query.ts'
import css from './Files.module.css'

/** One window of a text. */
export interface TextWindow<C> {
  /** The window's text; null for a binary file. */
  text: string | null
  /** The file is not text: its size shows instead. */
  binary: boolean
  /** The whole file's size in bytes. */
  size: number
  /** Where the next window starts (what `read` takes); null or absent at the end. */
  next?: C | null | undefined
  /** A line longer than a window may hold was cut short. */
  clipped?: boolean | undefined
}

export interface WindowedTextProps<C> {
  /**
   * Reads the window at `cursor`, the first one without it. A new function is
   * another text: the windows start over (memoize it on what it reads).
   */
  read: (cursor?: C) => Promise<TextWindow<C>>
  /** Names the text and picks its highlighting. */
  path: string
  /** A translator whose namespace carries the files dictionary. */
  t: Translate
}

export function WindowedText<C>({ read, path, t }: WindowedTextProps<C>): ReactNode {
  const first = useQuery(() => read(), [read])
  const [more, setMore] = useState<TextWindow<C>[]>([])
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
  const next = windows.at(-1)?.next ?? null
  const loadMore = () => {
    if (next == null) return
    setLoadingMore(true)
    read(next).then((w) => setMore((m) => [...m, w]), () => undefined).finally(() => setLoadingMore(false))
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
      {windows.some((w) => w.clipped) ? <p className={css.fileNote}>{t('files_lineClipped')}</p> : null}
    </div>
  )
}
