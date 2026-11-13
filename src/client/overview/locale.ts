/** The LayerFS page's copy. Machines and Storage words come from their own namespaces. */
export const NS = 'layerfsOverview'

const en = {
  panel: 'LayerFS',
  openPage: 'Open the LayerFS page',
  fold: 'Hide Center and Settings',
  unfold: 'Show Center and Settings',
  refresh: 'Refresh',
  health: 'Health',
  checkAgain: 'Check again',
  resources: 'Center',
  machines: 'Machines',
  storage: 'Storage',
  sandboxes: 'Sandboxes',
  workspaces: 'Workspaces',
  stores: 'Stores',
  projects: 'Projects',
  buckets: 'Buckets',
  open: 'Open {name}',
  reading: 'Reading…',
  unreadable: 'Could not read',
}

const zh: typeof en = {
  panel: 'LayerFS',
  openPage: '打开 LayerFS 页面',
  fold: '收起中心和设置',
  unfold: '展开中心和设置',
  refresh: '刷新',
  health: '健康',
  checkAgain: '重新检查',
  resources: '中心',
  machines: '机器',
  storage: '存储',
  sandboxes: 'Sandbox',
  workspaces: 'Workspace',
  stores: 'Store',
  projects: '项目',
  buckets: '存储桶',
  open: '打开{name}',
  reading: '正在读取…',
  unreadable: '无法读取',
}

export const locales = { en, zh }
export type OverviewKey = keyof typeof en
export type OverviewT = (key: OverviewKey, params?: Record<string, string | number>) => string
