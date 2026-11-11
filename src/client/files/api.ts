/** The project reads the shared file views make, over Connect's host routes. */
import { q, type LayerfsApi } from '../api.ts'
import type { BranchInfo, CommitDetail, FileDiffResult, FileWindow, FsEntry, HistoryBranch, HistoryPage } from './types.ts'

/** A project key's route: `<store>/<project>` as one encoded segment. */
export const projectPath = (project: string): string => `/api/projects/${encodeURIComponent(project)}`

export const filesApi = {
  branches: (api: LayerfsApi, project: string, pos = 0) =>
    api.call<{ items: BranchInfo[], next: number | null }>('GET', `${projectPath(project)}/branches${q({ pos })}`),
  list: (api: LayerfsApi, project: string, branch: string, path: string, pin?: string, pos = 0) =>
    api.call<{ items: FsEntry[], next: number | null, at: { id: string } }>('GET', `${projectPath(project)}/fs${q({ branch, path, pin, pos })}`),
  file: (api: LayerfsApi, project: string, branch: string, path: string, pin?: string, line = 1) =>
    api.call<FileWindow>('GET', `${projectPath(project)}/file${q({ branch, path, pin, line })}`),
  historyBranches: (api: LayerfsApi, project: string, pos = 0) =>
    api.call<{ branches: HistoryBranch[], next: number | null }>('GET', `${projectPath(project)}/history${q({ pos })}`),
  commits: (api: LayerfsApi, project: string, branch: string, at?: string) =>
    api.call<HistoryPage>('GET', `${projectPath(project)}/history${q({ branch, at })}`),
  commit: (api: LayerfsApi, project: string, branch: string, commit: string, from?: string, cursor?: string) =>
    api.call<CommitDetail>('GET', `${projectPath(project)}/history${q({ branch, commit, from, cursor })}`),
  /** `file.diff` of one path between two saved ids of `branch`. */
  fileDiff: (api: LayerfsApi, project: string, branch: string, path: string, left: string, pin: string) =>
    api.call<FileDiffResult>('GET', `${projectPath(project)}/file-query${q({ branch, path, pin, left, kind: 'compare', size: 1000 })}`),
}
