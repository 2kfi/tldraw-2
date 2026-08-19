import type { Editor } from 'tldraw'
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