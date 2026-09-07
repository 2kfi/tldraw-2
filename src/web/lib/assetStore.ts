import type { TLAssetStore } from 'tldraw'

// tldraw 5.x TLAssetStore: upload(asset, file, abortSignal?) -> { src },
// resolve(asset, ctx) -> string | null. Images/videos are streamed from our own
// server (`/media/asset/*`), so resolve is just `props.src`.
export const assetStore: TLAssetStore = {
  async upload(_asset, file) {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/assets', { method: 'POST', body: form })
    // Surface the server's message ('file too large (max 50 MB)',
    // 'SVG is not allowed', …) instead of a bare status code.
    if (!res.ok) {
      let message = `asset upload failed (${res.status})`
      try {
        const body = (await res.json()) as { error?: string }
        if (body?.error) message = body.error
      } catch {
        // keep the default message
      }
      throw new Error(message)
    }
    const { src } = (await res.json()) as { src: string }
    return { src }
  },
  resolve(asset) {
    return asset.props.src
  },
}
