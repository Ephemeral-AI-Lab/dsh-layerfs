export const NS = 'layerfsWorkAreas'
const en = {
  available: 'Available', stopped: 'Stopped', unavailable: 'Unavailable', checking: 'Checking…', starting: 'Starting…', busy: 'Busy',
  expandProject: 'Toggle conversations in {project}', archiveLoading: 'Checking archived conversations…', archiveFailed: 'Archived conversations unavailable: {message}',
  title: 'Work areas', layerfs: 'LayerFS Projects', dsh: 'DSH Projects',
  loading: 'Loading projects…', sessionsLoading: 'Loading sessions…', timedOut: 'The read timed out. Try again.', empty: 'No LayerFS projects yet', retry: 'Retry',
  failed: 'Could not load projects: {message}', sessionsFailed: 'Could not load sessions: {message}',
  untitled: 'New session', newSession: 'New session in {project}',
  manage: 'Manage LayerFS projects', noSessions: 'No sessions yet',
  actionFailed: 'Could not open the project session. Check the project’s machine, then retry.', machines: 'Machines', details: 'Details',
}
const zh: typeof en = {
  available: '可用', stopped: '已停止', unavailable: '不可用', checking: '正在检查…', starting: '正在启动…', busy: '处理中',
  expandProject: '展开或收起 {project} 中的对话', archiveLoading: '正在检查归档对话…', archiveFailed: '归档对话不可用：{message}',
  title: '工作区域', layerfs: 'LayerFS Projects', dsh: 'DSH Projects',
  loading: '正在加载项目…', sessionsLoading: '正在加载会话…', timedOut: '读取超时，请重试。', empty: '还没有 LayerFS 项目', retry: '重试',
  failed: '无法加载项目：{message}', sessionsFailed: '无法加载会话：{message}',
  untitled: '新会话', newSession: '在 {project} 中新建会话',
  manage: '管理 LayerFS 项目', noSessions: '还没有会话',
  actionFailed: '无法打开项目会话。请检查项目所在的机器后重试。', machines: '机器', details: '详情',
}
export const locales = { en, zh }
export type Translate = (key: keyof typeof en, params?: Record<string, string | number>) => string
