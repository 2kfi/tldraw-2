import { useEffect, useState } from 'react'

// Single source of truth for "isCompact" — used by JS (hooks) and CSS (the
// identical media string in theme.css). Plan 11.3: compact = narrow OR
// portrait-ish (aspect-ratio < 1.2, so a split-screen desktop window counts).
export const COMPACT_QUERY = '(max-width: 767px), (max-aspect-ratio: 6/5)'

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    mql.addEventListener('change', onChange)
    setMatches(mql.matches)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export function useIsCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY)
}
