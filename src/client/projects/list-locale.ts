/** Copy of the LayerFS Projects page and its sidebar row (namespace `layerfsProjectList`). */
export const NS = 'layerfsProjectList'
const en = {
  available: 'Available', stopped: 'Stopped', unavailable: 'Unavailable', checking: 'Checking…', starting: 'Starting…', busy: 'Busy',
  expandProject: 'Toggle conversations in {project}', archiveLoading: 'Checking archived conversations…', archiveFailed: 'Archived conversations unavailable: {message}',
  panel: 'Projects', layerfs: 'LayerFS Projects', openStorage: 'Open Storage', backToProjects: 'Back to Projects', manage: 'Open the LayerFS Projects page', showLayerfs: 'Show LayerFS projects', showDsh: 'Show DSH workspaces',
  loading: 'Loading projects…', sessionsLoading: 'Loading sessions…', timedOut: 'The read timed out. Try again.', empty: 'No LayerFS projects yet', retry: 'Retry',
  failed: 'Could not load projects: {message}', sessionsFailed: 'Could not load sessions: {message}',
  untitled: 'New session', newSession: 'New session in {project}',
  noSessions: 'No sessions yet',
  actionFailed: 'Could not open the project session. Check the project’s machine, then retry.', machines: 'Machines', details: 'Details',
  interrupted: 'Interrupted', interruptedHint: 'Execution was interrupted. History is kept; a new message re-activates it after access returns.',
  readyGroup: 'Ready · {n}', unavailableGroup: 'Unavailable · {n}',
  machineStopped: 'Machine stopped', machineUnavailable: 'Machine unavailable', storeUnavailable: 'Store unavailable',
  notVerified: 'Not verified', removed: 'Removed', replaced: 'Replaced',
  start: 'Start', startFailed: 'Could not start the project’s machine.', startMachineFor: 'Start machine {machine} for {project}',
}
const zh: typeof en = {
  available: '可用', stopped: '已停止', unavailable: '不可用', checking: '正在检查…', starting: '正在启动…', busy: '处理中',
  expandProject: '展开或收起 {project} 中的对话', archiveLoading: '正在检查归档对话…', archiveFailed: '归档对话不可用：{message}',
  panel: '项目', layerfs: 'LayerFS Projects', openStorage: '打开存储', backToProjects: '返回项目', manage: '打开 LayerFS 项目页面', showLayerfs: '显示 LayerFS 项目', showDsh: '显示 DSH 工作区',
  loading: '正在加载项目…', sessionsLoading: '正在加载会话…', timedOut: '读取超时，请重试。', empty: '还没有 LayerFS 项目', retry: '重试',
  failed: '无法加载项目：{message}', sessionsFailed: '无法加载会话：{message}',
  untitled: '新会话', newSession: '在 {project} 中新建会话',
  noSessions: '还没有会话',
  actionFailed: '无法打开项目会话。请检查项目所在的机器后重试。', machines: '机器', details: '详情',
  interrupted: '已中断', interruptedHint: '执行已中断。历史记录已保留；访问恢复后，发送新消息即可重新激活。',
  readyGroup: '可用 · {n}', unavailableGroup: '不可用 · {n}',
  machineStopped: '机器已停止', machineUnavailable: '机器不可用', storeUnavailable: 'Store 不可用',
  notVerified: '未验证', removed: '已移除', replaced: '已被替换',
  start: '启动', startFailed: '无法启动项目所在的机器。', startMachineFor: '为 {project} 启动机器 {machine}',
}
export const locales = { en, zh }
export type ListT = (key: keyof typeof en, params?: Record<string, string | number>) => string
