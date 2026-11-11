/**
 * Shared LayerFS file views: a project's saved files, its history and a
 * Commit's diff. Each takes the `LayerfsApi` and a `t` whose namespace
 * includes {@link filesEn} / {@link filesZh}.
 */
export { ProjectFiles, type ProjectFilesProps } from './ProjectFiles.tsx'
export { ProjectHistory, type ProjectHistoryProps } from './ProjectHistory.tsx'
export { CommitDiff, changeKind, hunksOf, type CommitDiffProps } from './CommitDiff.tsx'
export { FileViewer, codeLabels, type FileViewerProps } from './FileViewer.tsx'
export { BranchPicker, type BranchPickerProps } from './BranchPicker.tsx'
export { EmptyState, ErrorState, Loading } from './States.tsx'
export { useQuery, errorText, errorCode, type Query } from './use-query.ts'
export { ago, bytes, shortId, toMs, when } from './format.ts'
export { filesApi, projectPath } from './api.ts'
export { filesEn, filesZh } from './locale.ts'
export type * from './types.ts'
