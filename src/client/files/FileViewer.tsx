/**
 * One saved file of a project Branch, read-only, in three views: Code (the
 * text, line-numbered and highlighted), Blame (the saved version that last
 * wrote each line) and History (the versions that changed this file, each
 * with its diff). Selecting a version in Blame opens it in History.
 */
import { useCallback, useState, type ReactNode } from 'react'
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayerfsApi } from '../api.ts'
import { filesApi } from './api.ts'
import { FileBlame } from './FileBlame.tsx'
import { FileHistory } from './FileHistory.tsx'
import type { Translate } from './types.ts'
import { WindowedText, type TextWindow } from './WindowedText.tsx'
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

/** The Code view: the saved file in windows of lines (`file.read` from a line). */
function FileCode({ api, project, branch, path, pin, t }: Omit<FileViewerProps, 'mode' | 'onModeChange'>): ReactNode {
  const read = useCallback((line?: number): Promise<TextWindow<number>> => filesApi.file(api, project, branch, path, pin, line)
    .then((w) => ({ text: w.text, binary: w.binary, size: w.size, next: w.next_line, clipped: w.line_truncated })), [api, project, branch, path, pin])
  return <WindowedText read={read} path={path} t={t} />
}
