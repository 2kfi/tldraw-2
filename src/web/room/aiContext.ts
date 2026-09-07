import type { Editor } from 'tldraw'
import { MAX_SCREENSHOT_CHARS } from '../../shared/schema'
import { convertTldrawIdToSimpleId } from '../../shared/agent/format/convertTldrawShapeToFocusedShape'

export type AiContext = {
  selection: string[]
  viewport: { x: number; y: number; w: number; h: number }
}

/**
 * Snapshot of what the user is pointing at right now: the selected shapes
 * (as simplified ids, matching what the session resolves against) and the
 * current viewport page bounds. Stored on the aiState record when the user
 * submits a prompt so the server can rebuild focused/blurry context parts.
 */
export function getAiContext(editor: Editor): AiContext {
  const viewport = editor.getViewportPageBounds()
  return {
    selection: editor.getSelectedShapeIds().map(convertTldrawIdToSimpleId),
    viewport: { x: viewport.x, y: viewport.y, w: viewport.w, h: viewport.h },
  }
}

/**
 * Optional per-prompt viewport snapshot (default off). Downscaled JPEG via the
 * editor's exporter; size-gated so the sync record stays small. Returns null
 * when anything fails — the structured-data path runs unchanged.
 */
export async function captureViewportScreenshot(editor: Editor): Promise<string | null> {
  try {
    const viewport = editor.getViewportPageBounds()
    const inView = editor
      .getCurrentPageShapes()
      .filter((s) => {
        try {
          const b = editor.getShapeMaskedPageBounds(s)
          return !!b && b.collides(viewport as any)
        } catch {
          return false
        }
      })
      .slice(0, 40)
    if (inView.length === 0) return null
    const toImage = (editor as unknown as {
      toImageDataUrl?: (
        shapes: string[],
        opts: Record<string, unknown>
      ) => Promise<{ url?: string }>
    }).toImageDataUrl
    if (typeof toImage !== 'function') return null
    const res = await toImage.call(
      editor,
      inView.map((s) => s.id as string),
      { bounds: viewport, background: true, format: 'jpeg', quality: 0.6, scale: 0.5, pixelRatio: 1, padding: 0 }
    )
    const url = res?.url
    if (typeof url !== 'string' || !url.startsWith('data:image/')) return null
    if (url.length > MAX_SCREENSHOT_CHARS) return null
    return url
  } catch {
    return null
  }
}