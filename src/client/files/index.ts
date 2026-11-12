/**
 * Shared LayerFS file views: a project's saved files (Code, Blame and
 * History per file), its history graph, a Commit's diff and a comparison of
 * two saved versions. Each takes the `LayerfsApi` and a `t` whose namespace
 * includes {@link filesEn} / {@link filesZh}.
 */
export { ProjectFiles, type ProjectFilesProps } from './ProjectFiles.tsx'
export { ProjectHistory, type ProjectHistoryProps } from './ProjectHistory.tsx'
export { CommitDiff, PathDiff, changeKind, hunksOf, type CommitDiffProps, type PathDiffProps } from './CommitDiff.tsx'
export { FileViewer, type FileMode, type FileViewerProps } from './FileViewer.tsx'
export { FileBlame, type FileBlameProps } from './FileBlame.tsx'
export { FileHistory, type FileHistoryProps } from './FileHistory.tsx'
export { BranchCompare, type BranchCompareProps, type CompareEnd } from './BranchCompare.tsx'
export { codeLabels } from './labels.ts'
export { BranchPicker, type BranchPickerProps } from './BranchPicker.tsx'
export { EmptyState, ErrorState, Loading } from './States.tsx'
export { useQuery, errorText, errorCode, type Query } from './use-query.ts'
export { ago, bytes, shortId, toMs, when } from './format.ts'
export { filesApi, projectPath } from './api.ts'
export { filesEn, filesZh } from './locale.ts'
export type * from './types.ts'
