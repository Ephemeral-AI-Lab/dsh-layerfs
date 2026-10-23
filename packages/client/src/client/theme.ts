// The view's light or dark theme follows dsh's colour scheme, which dsh sets
// as color-scheme on the document element (none: the system's).
export function followTheme(root: HTMLElement): () => void {
  const apply = () => {
    const scheme = document.documentElement.style.colorScheme
    if (scheme === 'dark' || scheme === 'light') root.dataset.theme = scheme
    else delete root.dataset.theme
  }
  apply()
  const observer = new MutationObserver(apply)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  return () => observer.disconnect()
}
