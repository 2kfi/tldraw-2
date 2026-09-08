import { useLayoutEffect, useRef } from 'react'
import { COMPACT_QUERY } from './useMediaQuery'

// gsap ships in its own lazy chunk (dynamic import): the room paints and
// interacts before the animation engine arrives. Static `import gsap`
// anywhere on the initial path would defeat the React.lazy panel split
// (import type is erased — it adds no runtime dependency).
import type gsapDefault from 'gsap'
type Gs = typeof gsapDefault
let gsapCache: Gs | null = null
function loadGsap(): Promise<Gs> {
  if (gsapCache) return Promise.resolve(gsapCache)
  return import('gsap').then((m) => (gsapCache = ((m as any).default ?? m) as Gs))
}

const DESKTOP_QUERY = '(min-width: 768px) and (min-aspect-ratio: 6/5)'
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)'

type SlideSide = 'left' | 'right'

// Slide a docked panel in/out. Side decides the slide direction (left panels
// come in from the left edge, right panels from the right). Panels stay
// mounted while closed (autoAlpha → visibility:hidden) so e.g. the music
// <audio> keeps playing.
//
// gsap.matchMedia picks compact-vs-desktop params (shorter/snappier on
// compact); a paused timeline is played/reversed on open — resumed, never
// restarted. prefers-reduced-motion skips the transform entirely.
export function usePanelSlide(
  ref: { current: HTMLDivElement | null },
  side: SlideSide,
  open: boolean
) {
  const dir = side === 'left' ? -100 : 100
  const mmRef = useRef<{ compact: boolean } | null>(null)
  const tlRef = useRef<{ play: () => void; reverse: () => void } | null>(null)

  // matchMedia lives for the mount: breakpoint flips only retune params.
  useLayoutEffect(() => {
    let mm: { revert: () => void } | null = null
    let cancelled = false
    loadGsap().then((gsap) => {
      if (cancelled) return
      const m = gsap.matchMedia()
      mm = m
      m.add(
        { compact: COMPACT_QUERY, desktop: DESKTOP_QUERY, reduce: REDUCE_QUERY },
        (ctx: any) => {
          mmRef.current = { compact: !!ctx.conditions.compact }
        }
      )
    })
    return () => {
      cancelled = true
      mm?.revert()
    }
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (window.matchMedia(REDUCE_QUERY).matches) {
      tlRef.current = null
      el.style.transform = ''
      el.style.opacity = open ? '1' : '0'
      el.style.visibility = open ? 'inherit' : 'hidden'
      return
    }
    // Sync pre-set: gsap arrives async, so pin the closed state with plain
    // styles until the timeline takes over. Opacity/visibility only — never
    // touch transform here: GSAP parses the computed matrix into pixel x/y on
    // first contact, so a plain translateX(-100%) would bake in as x=-340px
    // and the later xPercent tween (which leaves x alone) could never undo
    // it — the panel would sit open-but-off-screen forever.
    if (!tlRef.current && !open) {
      el.style.opacity = '0'
      el.style.visibility = 'hidden'
    }
    let cancelled = false
    loadGsap().then((gsap) => {
      if (cancelled) return
      const compact = mmRef.current?.compact ?? window.matchMedia(COMPACT_QUERY).matches
      if (!tlRef.current) {
        const tl = gsap.timeline({ paused: true })
        tl.fromTo(
          el,
          { autoAlpha: 0, xPercent: dir },
          {
            autoAlpha: 1,
            xPercent: 0,
            duration: compact ? 0.25 : 0.32,
            ease: compact ? 'power3.out' : 'power2.out',
            overwrite: 'auto',
          }
        )
        tlRef.current = tl
        tl.progress(open ? 1 : 0)
        return
      }
      if (open) tlRef.current.play()
      else tlRef.current.reverse()
    })
    return () => {
      cancelled = true
    }
  }, [open])
}

// One orchestrated timeline for the RoomCanvas-owned chrome: the compact
// backdrop fades in while the top bar yields via --chrome-shift (a CSS var so
// the centered desktop calc never goes stale). Played on open, reversed on
// close — resumed, never restarted. Reduced-motion sets end states instantly.
// onReverseComplete fires when the close animation settles so the caller can
// drop the panels-open class only after the bar has slid home (no snap).
export function usePanelsTimeline(
  backdropRef: { current: HTMLDivElement | null },
  chromeRef: { current: HTMLDivElement | null },
  open: boolean,
  onReverseComplete?: () => void
) {
  const tlRef = useRef<{ play: () => void; reverse: () => void } | null>(null)
  const cbRef = useRef(onReverseComplete)
  cbRef.current = onReverseComplete

  useLayoutEffect(() => {
    const backdrop = backdropRef.current
    const chrome = chromeRef.current
    if (!backdrop || !chrome) return
    if (window.matchMedia(REDUCE_QUERY).matches) {
      tlRef.current = null
      backdrop.style.opacity = open ? '1' : '0'
      backdrop.style.visibility = open ? 'inherit' : 'hidden'
      chrome.style.setProperty('--chrome-shift', open ? '1' : '0')
      if (!open) cbRef.current?.()
      return
    }
    let cancelled = false
    loadGsap().then((gsap) => {
      if (cancelled) return
      if (!tlRef.current) {
        const tl = gsap.timeline({
          paused: true,
          defaults: { ease: 'power2.out', overwrite: 'auto' },
          onReverseComplete: () => cbRef.current?.(),
        })
        tl.fromTo(backdrop, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25 }, 0).fromTo(
          chrome,
          { '--chrome-shift': 0 },
          { '--chrome-shift': 1, duration: 0.32 },
          0
        )
        tlRef.current = tl
        tl.progress(open ? 1 : 0)
        if (open) tl.play()
        else cbRef.current?.()
        return
      }
      if (open) tlRef.current.play()
      else tlRef.current.reverse()
    })
    return () => {
      cancelled = true
    }
  }, [open])
}
