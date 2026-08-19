import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import { useValue } from 'tldraw'
import gsap from 'gsap'
import { MUSIC_STATE_ID, createDefaultMusicState } from '../../shared/schema'
import type { MusicState } from '../../shared/schema'
import type { MusicTrackInfo, MusicTracksResponse } from '../../shared/types'
import { api } from '../lib/api'
import { getHostKey, getHostToken } from '../lib/host'
import { getUser } from '../lib/user'
import { usePanelSlide } from '../lib/usePanelSlide'

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

export function MusicPanel({
  roomId,
  editor,
  open,
  onClose,
}: {
  roomId: string
  editor: Editor
  open: boolean
  onClose: () => void
}) {
  const store = editor.store
  const me = getUser()
  const isHost = getHostKey(roomId) !== null
  const panelRef = useRef<HTMLDivElement>(null)
  usePanelSlide(panelRef, 'right', open)

  // ponytail: validated at the sync boundary; the store's branded ids don't know
  // custom records, so cast (same pattern as AIPanel).
  const getMusic = () => store.get(MUSIC_STATE_ID as any) as MusicState | undefined
  const putMusic = (state: MusicState) => store.put([state] as any)
  const music = useValue('musicState', getMusic, [store])

  const [joined, setJoined] = useState(false)
  const joinedRef = useRef(joined)
  joinedRef.current = joined
  const [tracks, setTracks] = useState<MusicTrackInfo[]>([])
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [drag, setDrag] = useState<number | null>(null)

  const audioRef = useRef<HTMLAudioElement>(null)
  const discRef = useRef<HTMLDivElement>(null)
  const tweenRef = useRef<gsap.core.Tween | null>(null)
  const seekingRef = useRef(false)

  const canControl = isHost || (music?.allowedMemberIds ?? []).includes(me.id)

  const presences = useValue(
    'presences',
    () => store.query.records('instance_presence').get() as unknown as { userId: string; userName: string; color: string }[],
    [store]
  )

  const trackById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks])
  const current = music?.currentTrackId ? trackById.get(music.currentTrackId) : undefined

  function currentPos(state: MusicState): number {
    if (state.playing && state.startedAt) return state.positionMs + (Date.now() - state.startedAt)
    return state.positionMs
  }

  useEffect(() => {
    api<MusicTracksResponse>('/api/music')
      .then((res) => setTracks(res.tracks))
      .catch(() => setTracks([]))
  }, [])

  useEffect(() => {
    if (!store.get(MUSIC_STATE_ID as any)) putMusic(createDefaultMusicState(me.id))
  }, [store])

  // authoritative clock: always tick from the record so guests stay in sync
  useEffect(() => {
    if (!music) return
    const id = window.setInterval(() => {
      if (!seekingRef.current) setProgress(currentPos(music) / 1000)
    }, 250)
    return () => window.clearInterval(id)
  }, [music])

  // GSAP disc: continuous rotation while playing, paused otherwise. CSS can't
  // do a per-state tween we can resume, and @gsap/react isn't installed.
  useEffect(() => {
    const el = discRef.current
    if (!el) return
    const ctx = gsap.context(() => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      tweenRef.current = gsap.to(el, { rotation: '+=360', duration: 8, ease: 'none', repeat: -1, paused: true })
    })
    return () => ctx.revert()
  }, [])

  useEffect(() => {
    const tween = tweenRef.current
    if (!tween) return
    if (music?.playing && joined) tween.play()
    else tween.pause()
  }, [music?.playing, joined])

  // keep the <audio> engine matching the synced record
  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !music) return
    if (music.currentTrackId && audio.dataset.trackId !== music.currentTrackId) {
      audio.src = `/media/track/${music.currentTrackId}`
      audio.dataset.trackId = music.currentTrackId
    }
    const pos = currentPos(music) / 1000
    if (music.playing) {
      if (!joined) return // awaiting a gesture — the Join playback button shows
      if (!seekingRef.current) {
        if (Math.abs(audio.currentTime - pos) > 0.35 && Number.isFinite(audio.duration)) audio.currentTime = pos
        if (audio.paused) audio.play().catch(() => {})
      }
    } else {
      audio.pause()
      if (!seekingRef.current && Number.isFinite(audio.duration)) audio.currentTime = pos
    }
  }, [music, joined])

  function write(next: Partial<MusicState>) {
    const cur = getMusic() ?? createDefaultMusicState(me.id)
    putMusic({ ...cur, ...next, updatedBy: me.id })
  }

  function playTrack(trackId: string) {
    const cur = getMusic() ?? createDefaultMusicState(me.id)
    const queue = cur.queue.length ? cur.queue : tracks.map((t) => t.id)
    if (!queue.includes(trackId)) queue.push(trackId)
    putMusic({ ...cur, currentTrackId: trackId, queue, playing: true, startedAt: Date.now(), positionMs: 0, updatedBy: me.id })
  }

  function togglePlay() {
    const cur = getMusic()
    if (!cur) return
    if (cur.playing) {
      putMusic({ ...cur, playing: false, startedAt: null, positionMs: currentPos(cur), updatedBy: me.id })
    } else if (cur.currentTrackId) {
      putMusic({ ...cur, playing: true, startedAt: Date.now(), positionMs: cur.positionMs, updatedBy: me.id })
    }
  }

  function step(delta: number) {
    const cur = getMusic()
    if (!cur?.currentTrackId) return
    const queue = cur.queue.length ? cur.queue : tracks.map((t) => t.id)
    const idx = queue.indexOf(cur.currentTrackId)
    // current track was removed by a rescan (idx -1) or the queue is empty:
    // stepping is a no-op instead of wrapping onto the wrong track.
    if (queue.length === 0 || idx < 0) return
    const next = queue[(idx + delta + queue.length) % queue.length]
    if (next) playTrack(next)
  }

  function seekTo(ms: number) {
    const cur = getMusic()
    if (!cur) return
    const playing = cur.playing
    putMusic({ ...cur, positionMs: ms, startedAt: playing ? Date.now() : null, updatedBy: me.id })
  }

  function commitSeek(value: string) {
    const t = Number(value)
    setDrag(null)
    seekingRef.current = false
    if (Number.isFinite(t)) seekTo(t * 1000)
  }

  async function refresh() {
    const token = getHostToken(roomId)
    if (!token) return
    setRefreshError(null)
    try {
      await api<MusicTracksResponse>('/api/music/refresh', {
        method: 'POST',
        headers: { 'X-Host-Token': token },
      })
      const res = await api<MusicTracksResponse>('/api/music')
      setTracks(res.tracks)
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'refresh failed')
    }
  }

  function toggleDJ(rawUserId: string) {
    const cur = getMusic() ?? createDefaultMusicState(me.id)
    const set = new Set(cur.allowedMemberIds)
    if (set.has(rawUserId)) set.delete(rawUserId)
    else set.add(rawUserId)
    putMusic({ ...cur, allowedMemberIds: [...set], updatedBy: me.id })
  }

  function nameFor(rawUserId: string): string {
    if (rawUserId === me.id) return `${me.name} (you)`
    const p = presences.find((pr) => pr.userId === 'user:' + rawUserId)
    return p?.userName ?? rawUserId.slice(0, 6)
  }

  return (
    <aside className="music-panel" ref={panelRef}>
      <div className="music-header">
        <div className="music-title">
          <span>Music</span>
          <span className="music-title-actions">
            {isHost && (
              <button className="music-btn" onClick={refresh}>
                Refresh
              </button>
            )}
            <button className="music-btn" onClick={onClose} title="Collapse">
              ✕
            </button>
          </span>
        </div>
      </div>

      <div className="music-body">
        <div className="music-now">
          <div className="music-disc" ref={discRef}>
            <div
              className="music-disc-art"
              style={current?.artUrl ? { backgroundImage: `url(${current.artUrl})` } : undefined}
            />
            <div className="music-disc-label" />
          </div>
          <div className="music-now-info">
            <div className="music-track-title">{current?.title ?? 'Nothing playing'}</div>
            <div className="music-track-artist">{current?.artist || current?.album || '—'}</div>
          </div>
          {music?.playing && !joined && (
            <button className="music-join" onClick={() => setJoined(true)}>
              Join playback
            </button>
          )}
        </div>

        {current && (
          <div className="music-controls">
            <input
              className="music-range"
              type="range"
              min={0}
              max={current.duration || 0}
              step={0.1}
              value={drag ?? progress}
              disabled={!canControl}
              onChange={(e) => {
                seekingRef.current = true
                setDrag(Number(e.target.value))
              }}
              onPointerUp={(e) => commitSeek(e.currentTarget.value)}
              onKeyUp={(e) => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) commitSeek(e.currentTarget.value)
              }}
            />
            <div className="music-time">
              <span>{fmt(drag ?? progress)}</span>
              <span>{fmt(current.duration)}</span>
            </div>
            <div className="music-buttons">
              <button className="music-btn" onClick={() => step(-1)} disabled={!canControl}>
                ⏮
              </button>
              <button className="music-btn music-play" onClick={togglePlay} disabled={!canControl}>
                {music?.playing ? '❚❚' : '▶'}
              </button>
              <button className="music-btn" onClick={() => step(1)} disabled={!canControl}>
                ⏭
              </button>
            </div>
            {!canControl && <div className="music-hint">Only the host or a promoted DJ can control playback.</div>}
          </div>
        )}

        <div className="music-queue">
          {tracks.map((t) => (
            <button
              key={t.id}
              className={`music-track${t.id === music?.currentTrackId ? ' active' : ''}`}
              onClick={() => playTrack(t.id)}
              disabled={!canControl}
            >
              <span className="music-track-title2">{t.title}</span>
              <span className="music-track-artist2">
                {[t.artist, t.album].filter(Boolean).join(' · ') || fmt(t.duration)}
              </span>
            </button>
          ))}
          {tracks.length === 0 && (
            <div className="music-empty">
              No tracks found. Drop audio files into the music folder, then hit Refresh.
            </div>
          )}
        </div>

        <div className="music-djs">
          <div className="music-djs-title">DJs</div>
          <div className="music-djs-list">
            {isHost ? (
              <>
                <span className="music-dj music-dj-self">You (host)</span>
                {music?.allowedMemberIds.map((uid) => (
                  <span key={uid} className="music-dj">
                    {nameFor(uid)}
                    <button className="music-dj-x" onClick={() => toggleDJ(uid)} title="Revoke DJ">
                      ✕
                    </button>
                  </span>
                ))}
                {presences
                  .filter((p) => p.userId !== 'user:' + me.id && !(music?.allowedMemberIds ?? []).includes(p.userId.slice('user:'.length)))
                  .map((p) => (
                    <button key={p.userId} className="music-dj music-dj-promote" onClick={() => toggleDJ(p.userId.slice('user:'.length))}>
                      {p.userName} +DJ
                    </button>
                  ))}
              </>
            ) : (
              (music?.allowedMemberIds ?? []).map((uid) => <span key={uid} className="music-dj">{nameFor(uid)}</span>)
            )}
          </div>
        </div>
        {refreshError && <div className="music-status-error">{refreshError}</div>}
      </div>

      <audio
        ref={audioRef}
        preload="metadata"
        onLoadedMetadata={() => {
          const a = audioRef.current
          const m = getMusic()
          if (a && m && joinedRef.current && Number.isFinite(a.duration)) a.currentTime = currentPos(m) / 1000
        }}
      />
    </aside>
  )
}