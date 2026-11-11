/** Copy of the sidebar's Projects page (namespace `layerfsProjects`). */
export const NS = 'layerfsProjects'

const en = {
  panel: 'Projects',
  title: 'LayerFS Projects',
  intro: 'Sessions in a LayerFS project — each with its own Workspace, scratch folder and checkpoints. Plain folder workspaces stay in the Workspaces list.',
  loading: 'Loading projects…',
  loadFailed: 'Could not list projects: {message}',
  retry: 'Retry',
  newSession: 'New session',
  newEmpty: 'New empty project',
  importProject: 'Import project…',
  newEmptyTitle: 'New empty project',
  importTitle: 'Import project',
  cancel: 'Cancel',
  close: 'Close',
  emptyTitle: 'No LayerFS projects yet',
  emptyBody: 'Create an empty project or import a folder as a project.',
  noSessions: 'No sessions yet',
  sessionUntitled: 'New session',
  stored: 'In the LayerFS home',
  storedHint: 'Stored in the project; opens by importing it into this DSH',
  onMachine: 'On {machine}: pull the Store to this host to use it',
  sessionsError: 'Could not list sessions: {message}',
  importing: 'Importing {name}…',
  importFailed: 'Import failed: {message}',
}

const zh: typeof en = {
  panel: '项目',
  title: 'LayerFS 项目',
  intro: '在 LayerFS 项目中运行的会话 —— 每个都有自己的工作区、草稿文件夹和检查点。普通文件夹工作区仍在上方的工作区列表中。',
  loading: '正在加载项目…',
  loadFailed: '无法列出项目：{message}',
  retry: '重试',
  newSession: '新建会话',
  newEmpty: '新建空项目',
  importProject: '导入项目…',
  newEmptyTitle: '新建空项目',
  importTitle: '导入项目',
  cancel: '取消',
  close: '关闭',
  emptyTitle: '还没有 LayerFS 项目',
  emptyBody: '创建一个空项目，或将一个文件夹导入为项目。',
  noSessions: '还没有会话',
  sessionUntitled: '新会话',
  stored: '在 LayerFS 主目录中',
  storedHint: '存储在项目中；打开时会导入到本 DSH',
  onMachine: '位于 {machine}：请先将存储拉回本机',
  sessionsError: '无法列出会话：{message}',
  importing: '正在导入 {name}…',
  importFailed: '导入失败：{message}',
}

export const locales = { en, zh }
export type ProjectsKey = keyof typeof en
export type ProjectsT = (key: ProjectsKey, params?: Record<string, string | number>) => string
