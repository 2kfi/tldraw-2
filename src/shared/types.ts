export type UserInfo = {
  id: string
  name: string
  color: string
}

export type AiModelInfo = {
  id: string
  name: string
  provider: string
  /** False when the entry comes from a live provider fetch, not the static definitions. */
  known?: boolean
}

export type AiModelsResponse = {
  models: AiModelInfo[]
  /** True when a configured provider's live model fetch failed (static defs still returned). */
  liveFailed?: boolean
}

export type MusicTrackInfo = {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  artUrl: string | null
}

export type MusicTracksResponse = {
  tracks: MusicTrackInfo[]
  scannedAt: number
}