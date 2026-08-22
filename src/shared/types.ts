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
  /** False = served by the endpoint but not runnable by the agent (embeddings, image, tts…). */
  chat?: boolean
}

export type AiModelsResponse = {
  models: AiModelInfo[]
  /** True when a configured provider's live model fetch failed (static defs still returned). */
  liveFailed?: boolean
  /** Providers whose configured key was actively rejected (401/403/API_KEY_INVALID). Their models are withheld. */
  authFailed?: string[]
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