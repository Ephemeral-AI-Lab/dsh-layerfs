// LayerFS's Work and History tabs in dsh's conversation tab row, drawn as one
// group: the logo before Work, a divider between them and one faint track under
// both. dsh tab labels are plain text, so this marks the two tabs by their
// labels and draws the rest in CSS; it touches nothing else in dsh's markup.
const MARK = 'data-lfs-tab'
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="14 8 172 172"><path d="M88.5 22 L111.5 22 L170 135 L148.5 135 L100 49.5 L51.5 135 L30 135 Z" fill="#93B1E0" stroke="#93B1E0" stroke-width="2" stroke-linejoin="round"/><path d="M27 161 L57 161 L100 117 L143 161 L173 161" fill="none" stroke="#2F5BB5" stroke-width="10.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="100" cy="117" r="15.5" fill="#2F5BB5"/><circle cx="27" cy="161" r="15.5" fill="#2F5BB5"/><circle cx="173" cy="161" r="15.5" fill="#2F5BB5"/></svg>`
const TABS = `[data-conversation-tabs] [${MARK}]`
const TRACK = '#d6dae1'
const RULE = [
  `${TABS} { position: relative; background: linear-gradient(${TRACK}, ${TRACK}) left bottom / 100% 1px no-repeat; }`,
  `${TABS}[${MARK}="work"] { margin-right: -12px; }`,
  `${TABS}[${MARK}="work"]::before { content: ""; display: inline-block; width: 15px; height: 15px; margin: 0 6px 0 0; vertical-align: -2px; background: url("data:image/svg+xml,${encodeURIComponent(LOGO)}") center / contain no-repeat; }`,
  `${TABS}[${MARK}="work"]::after { left: 21px; }`,
  `${TABS}[${MARK}="history"]::before { content: ""; position: absolute; left: -24px; width: 24px; top: 0; bottom: 0; background: linear-gradient(#c9ced6, #c9ced6) center 2px / 1px 12px no-repeat, linear-gradient(${TRACK}, ${TRACK}) left bottom / 100% 1px no-repeat; }`,
].join('\n')

/** Marks the Work and History tabs (by label) whenever dsh draws its tab row; returns the stop. */
export function markLayerFsTabs(doc: Document, labels: { work: string; history: string }): () => void {
  if (!doc.getElementById('lfs-tab-logo')) {
    const style = doc.createElement('style')
    style.id = 'lfs-tab-logo'
    style.textContent = RULE
    doc.head.appendChild(style)
  }
  let frame = 0
  const mark = () => {
    frame = 0
    for (const tab of doc.querySelectorAll(`[data-conversation-tabs] [role="tab"]:not([${MARK}])`)) {
      const label = tab.textContent?.trim()
      if (label === labels.work) tab.setAttribute(MARK, 'work')
      else if (label === labels.history) tab.setAttribute(MARK, 'history')
    }
  }
  const seen = new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(mark)
  })
  seen.observe(doc.body, { childList: true, subtree: true })
  mark()
  return () => {
    seen.disconnect()
    if (frame) cancelAnimationFrame(frame)
  }
}
