import type { TLAssetStore } from 'tldraw'

// tldraw 5.x TLAssetStore: upload(asset, file, abortSignal?) -> { src },
// resolve(asset, ctx) -> string | null. Images/videos are streamed from our own
// server (`/media/asset/*`), so resolve is just `props.src`.
export const assetStore: TLAssetStore = {
  async upload(_asset, file) {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/assets', { method: 'POST', body: form })
    if (!res.ok) throw new Error(`asset upload failed (${res.status})`)
    const { src } = (await res.json()) as { src: string }
    return { src }
  },
  resolve(asset) {
    return asset.props.src
  },
}
