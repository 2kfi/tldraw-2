export type UserInfo = {
  id: string
  name: string
  color: string
}

export type AiModelInfo = {
  id: string
  name: string
  provider: string
}

export type AiModelsResponse = {
  models: AiModelInfo[]
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