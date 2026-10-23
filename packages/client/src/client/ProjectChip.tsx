// The LayerFS project a session works in, named beside its title in dsh's
// session header (conversation.session.header.actions), so the binding shows
// on every tab. A read-only label like the agent preset beside it: the
// project is chosen on the new-session screen and in the Work tab. It reads
// the Host's light binding route while the page is visible, so a choice made
// meanwhile shows; a session with no project shows nothing.
import { useEffect, useState } from 'react'
import { api } from './api.ts'

const POLL_MS = 4000
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="14 8 172 172"><path d="M88.5 22 L111.5 22 L170 135 L148.5 135 L100 49.5 L51.5 135 L30 135 Z" fill="#93B1E0"/><path d="M27 161 L57 161 L100 117 L143 161 L173 161" fill="none" stroke="#2F5BB5" stroke-width="10.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="100" cy="117" r="15.5" fill="#2F5BB5"/><circle cx="27" cy="161" r="15.5" fill="#2F5BB5"/><circle cx="173" cy="161" r="15.5" fill="#2F5BB5"/></svg>`
const ICON = `url("data:image/svg+xml,${encodeURIComponent(LOGO)}")`

type Binding = Awaited<ReturnType<typeof api.binding>>

export function ProjectChip({ sessionId }: { sessionId: string }) {
  const [binding, setBinding] = useState<Binding | null>(null)
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      if (document.visibilityState === 'visible') {
        // a failed read keeps what was shown; LayerFS being away is the Work tab's to say
        try { const next = await api.binding(sessionId); if (!stopped) setBinding(next) } catch { /* kept */ }
      }
      if (!stopped) timer = setTimeout(read, POLL_MS)
    }
    void read()
    return () => { stopped = true; clearTimeout(timer) }
  }, [sessionId])
  const name = binding?.project?.name
  if (!name) return null
  const fixed = binding?.choice?.locked
  const title = `LayerFS project ${name}${binding?.folder ? ` · folder ${binding.folder}` : ''}${fixed ? ' · fixed: an agent has used it' : ' · it can still be changed in the Work tab'}`
  return (
    <span title={title} style={CHIP}>
      <span aria-hidden="true" style={{ width: 13, height: 13, flex: 'none', background: `${ICON} center / contain no-repeat` }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
    </span>
  )
}

const CHIP = {
  display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: 220, height: 22, padding: '0 7px 0 5px',
  borderRadius: 'var(--dsw-radius-xs, 4px)', background: 'color-mix(in srgb, #2F5BB5 9%, transparent)',
  border: '1px solid color-mix(in srgb, #2F5BB5 22%, transparent)', fontSize: 12, lineHeight: '20px',
  color: 'var(--dsw-alias-label-secondary, #3d4450)', whiteSpace: 'nowrap', boxSizing: 'border-box',
} as const
