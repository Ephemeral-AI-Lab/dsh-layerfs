/** The project reads the shared file views make, over Connect's host routes. */
import { q, type LayerfsApi } from '../api.ts'
import type { BlameResult, BranchDiffPage, BranchInfo, CommitDetail, FileDiffResult, FileWindow, FsEntry, HistoryBranch, HistoryPage, RevisionPage } from './types.ts'

/** A project key's route: `<store>/<project>` as one encoded segment. */
export const projectPath = (project: string): string => `/api/projects/${encodeURIComponent(project)}`

/**
 * Branches the plugin keeps inside a project for its own bookkeeping: the
 * project's identity (`dsh.project.<uuid>`) and conversation archives
 * (`dsh.session.<id>`). Never browsable; session code branches (`dsh.<id>`) stay.
 */
export const isInternalBranch = (name: string): boolean => name.startsWith('dsh.project.') || name.startsWith('dsh.session.')

export const filesApi = {
  branches: (api: LayerfsApi, project: string, pos = 0) =>
    api.call<{ items: BranchInfo[], next: number | null }>('GET', `${projectPath(project)}/branches${q({ pos })}`)
      .then((page) => ({ ...page, items: page.items.filter((b) => !isInternalBranch(b.name)) })),
  list: (api: LayerfsApi, project: string, branch: string, path: string, pin?: string, pos = 0) =>
    api.call<{ items: FsEntry[], next: number | null, at: { id: string } }>('GET', `${projectPath(project)}/fs${q({ branch, path, pin, pos })}`),
  file: (api: LayerfsApi, project: string, branch: string, path: string, pin?: string, line = 1) =>
    api.call<FileWindow>('GET', `${projectPath(project)}/file${q({ branch, path, pin, line })}`),
  historyBranches: (api: LayerfsApi, project: string, pos = 0) =>
    api.call<{ branches: HistoryBranch[], next: number | null }>('GET', `${projectPath(project)}/history${q({ pos })}`)
      .then((page) => ({ ...page, branches: page.branches.filter((b) => !isInternalBranch(b.name)) })),
  commits: (api: LayerfsApi, project: string, branch: string, at?: string) =>
    api.call<HistoryPage>('GET', `${projectPath(project)}/history${q({ branch, at })}`),
  commit: (api: LayerfsApi, project: string, branch: string, commit: string, from?: string, cursor?: string) =>
    api.call<CommitDetail>('GET', `${projectPath(project)}/history${q({ branch, commit, from, cursor })}`),
  /**
   * `file.diff` of one path: `left` (saved on `leftBranch`, default `branch`)
   * against `pin` on `branch`. `attribution` also compares each line's owner.
   */
  fileDiff: (api: LayerfsApi, project: string, branch: string, path: string, left: string, pin: string, leftBranch?: string, attribution = false) =>
    api.call<FileDiffResult>('GET', `${projectPath(project)}/file-query${q({ branch, path, pin, left, rightBranch: leftBranch, kind: attribution ? 'attribution' : 'compare', size: 1000 })}`),
  /** `file.blame`: up to 1000 lines from `line`, each with the saved version that last wrote it. */
  blame: (api: LayerfsApi, project: string, branch: string, path: string, pin?: string, line = 1) =>
    api.call<BlameResult>('GET', `${projectPath(project)}/file-query${q({ branch, path, pin, line, kind: 'blame' })}`),
  /** `file.revision`: the saved changes to a path, newest first; `provenance` follows forks into other branches. */
  revisions: (api: LayerfsApi, project: string, branch: string, path: string, pin: string | undefined, traversal: 'provenance' | 'branch', continuation?: string) =>
    api.call<RevisionPage>('GET', `${projectPath(project)}/file-query${q({ branch, path, pin, traversal, continuation, kind: 'revisions', size: 50 })}`),
  /** `branch.diff`: the paths that differ from `from` (saved on `fromBranch`) to `pin` on `branch`, with owner changes. */
  branchDiff: (api: LayerfsApi, project: string, fromBranch: string, from: string | undefined, branch: string, pin: string | undefined, continuation?: string) =>
    api.call<BranchDiffPage>('GET', `${projectPath(project)}/file-query${q({ branch, pin, rightBranch: fromBranch, left: from, path: '/', continuation, kind: 'branch-diff', size: 100 })}`),
}
