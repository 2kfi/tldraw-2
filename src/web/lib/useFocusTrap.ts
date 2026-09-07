import { useEffect, useRef } from 'react'

// Focus trap matching the share-modal pattern: Escape closes, Tab wraps
// inside, focus moves in on open and restores to the opener on close.
export function useFocusTrap(
  ref: { current: HTMLDivElement | HTMLElement | null },
  open: boolean,
  onClose: () => void
) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const prevFocus = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const modal = ref.current
      if (!modal) return
      const focusables = modal.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
      )
      if (focusables.length === 0) return
      const first = focusables[0]!
      const last = focusables[focusables.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    ref.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKey)
      prevFocus?.focus()
    }
  }, [open])
}
