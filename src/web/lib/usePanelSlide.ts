import { useEffect, useLayoutEffect, useRef } from 'react'
import gsap from 'gsap'

// Slide a docked panel in/out. Side decides the slide direction (left panels
// come in from the left edge, right panels from the right). Panels stay
// mounted while closed (autoAlpha → visibility:hidden) so e.g. the music
// <audio> keeps playing. Respects prefers-reduced-motion: no transform.
export function usePanelSlide(
  ref: { current: HTMLDivElement | null },
  side: 'left' | 'right',
  open: boolean
) {
  const dir = side === 'left' ? -100 : 100
  const initialized = useRef(new WeakSet<HTMLDivElement>())

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!initialized.current.has(el)) {
      initialized.current.add(el)
      gsap.set(el, { autoAlpha: open ? 1 : 0, xPercent: reduced ? 0 : open ? 0 : dir })
      return
    }
    if (reduced) {
      gsap.set(el, { autoAlpha: open ? 1 : 0 })
      return
    }
    gsap.to(el, {
      autoAlpha: open ? 1 : 0,
      xPercent: open ? 0 : dir,
      duration: 0.3,
      ease: 'power2.out',
      overwrite: 'auto',
    })
  }, [open])

  useEffect(() => {
    const el = ref.current
    return () => {
      if (el) gsap.killTweensOf(el)
    }
  }, [])
}
