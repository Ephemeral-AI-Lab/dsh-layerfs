// The demo workspace's Sessions belong to their demos (Play replaces them),
// so dsh's controls that add, fork, archive, pin, rename or move one are
// hidden for them, and the workspace's folder row is drawn apart from other
// workspaces. dsh has no per-workspace setting for these: a stylesheet keyed
// to the sidebar's row keys (data-row-key) and the chat's Session
// (data-conversation-session) hides them, and the Session shortcuts are
// stopped before dsh reads them while a demo Session is open.
import { useEffect } from 'react'

const quote = (text: string) => JSON.stringify(text)
// dsh's CSS module classes keep their local name after a hash prefix (UCFH7G_rowActions)
const part = (name: string) => `[class*=${quote(`_${name}`)}]`
// the chat's Branch button, by its label in dsh's English and Chinese dictionaries
const BRANCH = ['Branch into a new conversation', '在新对话中分支']

function addStyle(text: string): () => void {
  const style = document.createElement('style')
  style.textContent = text
  document.head.append(style)
  return () => style.remove()
}

/**
 * Hides the demo workspace's sidebar row actions (New session, the
 * workspace's menu, each Session's menu, Archive and Pin), its Sessions'
 * rename by double-click and their drag, and marks its folder row.
 * @param workspaceId the demo workspace's dsh Workspace id
 * @returns removes the stylesheet
 */
export function lockDemoWorkspace(workspaceId: string): () => void {
  const row = `[data-row-key=${quote(`workspace:${workspaceId}`)}]`
  // the workspace's section: its row and its Session rows, each in a span of their own
  const sessions = `div:has(> span > ${row}) [data-row-key^="session:"]`
  const accent = '#7c5cff', accent2 = '#00a3a3'
  return addStyle(`
${row} ${part('rowActions')}, ${sessions} ${part('rowActions')} { display: none !important; }
${sessions} ${part('title')} { pointer-events: none; }
${sessions} { -webkit-user-drag: none; }
${row} {
  border-radius: 8px;
  background: linear-gradient(90deg, color-mix(in srgb, ${accent} 20%, transparent), color-mix(in srgb, ${accent2} 8%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, ${accent} 40%, transparent);
}
${row} ${part('folder')} { color: ${accent}; }
${row} ${part('projectText')} { flex-direction: row; align-items: center; gap: 6px; }
${row} ${part('title')} { font-weight: 600; }
${row} ${part('projectText')}::after {
  content: "DEMO"; flex: none; padding: 1px 5px; border-radius: 4px;
  font-size: 9px; font-weight: 700; letter-spacing: 0.08em; line-height: 14px; color: #fff;
  background: linear-gradient(90deg, ${accent}, ${accent2});
}
`)
}

// dsh's Session shortcuts (ui-workspace shortcuts.ts), desktop and web
// bindings both: fork F, archive A and rename G, with the primary key and Alt or Shift
const SHORTCUT = /^Key[FAG]$/
const blocked = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && SHORTCUT.test(e.code)
  && (e.altKey || (e.shiftKey && e.code !== 'KeyG'))

/**
 * While a demo Session is open: hides the chat's Branch buttons in it and
 * stops the fork, archive and rename shortcuts.
 * @param sessionId the demo Session, or null for none
 */
export function useDemoSessionLock(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId) return
    const chat = `[data-conversation-session=${quote(sessionId)}]`
    const removeStyle = addStyle(`${BRANCH.map((label) => `${chat} button[aria-label=${quote(label)}]`).join(', ')} { display: none !important; }`)
    const stop = (e: KeyboardEvent) => { if (blocked(e)) { e.preventDefault(); e.stopImmediatePropagation() } }
    window.addEventListener('keydown', stop, true)
    return () => { removeStyle(); window.removeEventListener('keydown', stop, true) }
  }, [sessionId])
}
