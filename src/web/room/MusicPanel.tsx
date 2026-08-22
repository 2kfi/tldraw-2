import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import { useValue } from 'tldraw'
import gsap from 'gsap'
import { MUSIC_STATE_ID, createDefaultMusicState } from '../../shared/schema'
import type { MusicState } from '../../shared/schema'
import type { MusicTrackInfo, MusicTracksResponse } from '../../shared/types'
import { api } from '../lib/api'
import { getHostKey, getHostToken } from '../lib/host'
import { useUser } from '../lib/user'
import { usePanelSlide } from '../lib/usePanelSlide'

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

/* Line icons matching the 1.6-stroke style used in RoomChrome/AIPanel. */
function IconX() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function IconVolume({ level }: { level: 0 | 1 | 2 }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 9.5v5h3l4 3.5v-12L7 9.5H4Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      {level === 0 ? (
        <path d="M15 9.5l5 5M20 9.5l-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ) : (
        <>
          <path d="M14.5 9.8a3.4 3.4 0 0 1 0 4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          {level === 2 && (
            <path d="M17 7.2a7 7 0 0 1 0 9.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          )}
        </>
      )}
    </svg>
  )
}

function IconPrev() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6.5 5.5v13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M17.5 6v12L9 12l8.5-6Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}

function IconNext() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M17.5 5.5v13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M6.5 6v12L15 12 6.5 6Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8.5 5.5v13L18 12 8.5 5.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9 5.5v13M15 5.5v13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
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
  const me = useUser()
  // localStorage + JSON.parse per render adds up; the host key only changes on
  // claim (which reloads state), so memoize per roomId.
  const isHost = useMemo(() => getHostKey(roomId) !== null, [roomId])
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
  const [playbackError, setPlaybackError] = useState<string | null>(null)

  // per-browser volume (local only — never synced to the room)
  const [volume, setVolume] = useState(() => {
    const v = Number(localStorage.getItem('t2.volume'))
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 80
  })
  const [muted, setMuted] = useState(() => localStorage.getItem('t2.volumeMuted') === '1')

  const audioRef = useRef<HTMLAudioElement>(null)
  const discRef = useRef<HTMLDivElement>(null)
  const tweenRef = useRef<gsap.core.Tween | null>(null)
  const seekingRef = useRef(false)

  // apply the local volume to the shared <audio> element; purely per-browser
  useEffect(() => {
    const audio = audioRef.current
    if (audio) audio.volume = muted ? 0 : volume / 100
  }, [volume, muted])

  function setVolumeAndPersist(v: number) {
    setVolume(v)
    localStorage.setItem('t2.volume', String(v))
    if (v === 0) {
      setMuted(true)
      localStorage.setItem('t2.volumeMuted', '1')
    } else if (muted) {
      setMuted(false)
      localStorage.removeItem('t2.volumeMuted')
    }
  }

  function toggleMute() {
    setMuted((m) => {
      localStorage.setItem('t2.volumeMuted', m ? '0' : '1')
      return !m
    })
  }

  const canControl = isHost || (music?.allowedMemberIds ?? []).includes(me.id)

  // Only subscribe while the panel is open: the compute touches the store
  // conditionally, so closed panels track no signals and never re-render on
  // collaborator cursor moves.
  const presences = useValue(
    'presences',
    () =>
      open
        ? (store.query.records('instance_presence').get() as unknown as {
            userId: string
            userName: string
            color: string
          }[])
        : [],
    [store, open]
  )

  const trackById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks])
  const current = music?.currentTrackId ? trackById.get(music.currentTrackId) : undefined

  function currentPos(state: MusicState): number {
    if (state.playing && state.startedAt) return state.positionMs + (Date.now() - state.startedAt)
    return state.positionMs
  }

  useEffect(() => {
    let cancelled = false
    api<MusicTracksResponse>('/api/music')
      .then((res) => { if (!cancelled) setTracks(res.tracks) })
      .catch(() => { if (!cancelled) setTracks([]) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!store.get(MUSIC_STATE_ID as any)) putMusic(createDefaultMusicState(me.id))
  }, [store])

  // authoritative clock: always tick from the record so guests stay in sync
  useEffect(() => {
    if (!music) return
    const id = window.setInterval(() => {
      // closed panel → nobody sees the number; paused → position is constant
      // (React bails on the identical setState), so only playing ticks render.
      if (!open || seekingRef.current) return
      const pos = currentPos(music) / 1000
      setProgress((prev) => (prev === pos ? prev : pos))
    }, 250)
    return () => window.clearInterval(id)
  }, [music, open])

  // GSAP disc: continuous rotation while playing, paused otherwise. CSS can't
  // do a per-state tween we can resume, and @gsap/react isn't installed.
  useEffect(() => {
    const el = discRef.current
    if (!el) return
    const ctx = gsap.context(() => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      tweenRef.current = gsap.to(el, { rotation: 360, duration: 8, ease: 'none', repeat: -1, paused: true })
    })
    return () => ctx.revert()
  }, [])

  useEffect(() => {
    const tween = tweenRef.current
    if (!tween) return
    // hidden panel → don't spin the disc off-screen
    if (!open || !music?.playing || !joined) {
      tween.pause()
      return
    }
    tween.restart()
    tween.play()
  }, [music?.playing, joined, open])

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
        if (audio.paused) audio.play().catch(() => { setPlaybackError('Playback failed — click any track, then press play.'); write({ playing: false }) })
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
    setPlaybackError(null)
    setJoined(true)
    const cur = getMusic() ?? createDefaultMusicState(me.id)
    const queue = cur.queue.length ? [...cur.queue] : tracks.map((t) => t.id)
    if (!queue.includes(trackId)) queue.push(trackId)
    putMusic({ ...cur, currentTrackId: trackId, queue, playing: true, startedAt: Date.now(), positionMs: 0, updatedBy: me.id })
  }

  function togglePlay() {
    setPlaybackError(null)
    const cur = getMusic()
    if (!cur) return
    if (cur.playing) {
      putMusic({ ...cur, playing: false, startedAt: null, positionMs: currentPos(cur), updatedBy: me.id })
    } else if (cur.currentTrackId) {
      putMusic({ ...cur, playing: true, startedAt: Date.now(), positionMs: cur.positionMs, updatedBy: me.id })
    }
  }

  function step(delta: number) {
    setPlaybackError(null)
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
    if (!seekingRef.current) return
    const t = Number(value)
    setDrag(null)
    seekingRef.current = false
    if (Number.isFinite(t)) {
      seekTo(t * 1000)
      setProgress(t)
    }
  }

  // A pointerup can land outside the input (fast finger off-slider); commit
  // from a window-level listener too. The input's own onPointerUp/onKeyUp stay
  // as fast paths — commitSeek is guarded so it only runs once.
  useEffect(() => {
    if (drag === null) return
    const onUp = () => commitSeek(String(drag))
    window.addEventListener('pointerup', onUp)
    return () => window.removeEventListener('pointerup', onUp)
  }, [drag])

  function refresh() {
    const token = getHostToken(roomId)
    if (!token) return
    setRefreshError(null)
    const cancelledRef = { current: false }
    api<MusicTracksResponse>('/api/music/refresh', {
      method: 'POST',
      headers: { 'X-Host-Token': token },
    })
      .then(() => api<MusicTracksResponse>('/api/music'))
      .then((res) => { if (!cancelledRef.current) setTracks(res.tracks) })
      .catch((err) => { if (!cancelledRef.current) setRefreshError(err instanceof Error ? err.message : 'refresh failed') })
    return () => { cancelledRef.current = true }
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
            <button className="music-btn" onClick={onClose} title="Collapse" aria-label="Collapse">
              <IconX />
            </button>
          </span>
        </div>
      </div>

      <div className="music-body">
        <div className="music-now">
          <div className="music-disc" ref={discRef}>
            <div
              className="music-disc-art"
              style={current?.artUrl ? { backgroundImage: `url(${current.artUrl})` } : { background: 'linear-gradient(135deg, #3a3a3a, #1f1f1f)' }}
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

        <div className="music-volume">
          <button
            className="music-btn music-vol-toggle"
            onClick={toggleMute}
            title={muted ? 'Unmute' : 'Mute'}
            aria-label={muted ? 'Unmute' : 'Mute'}
            aria-pressed={muted}
          >
            <IconVolume level={muted || volume === 0 ? 0 : volume < 50 ? 1 : 2} />
          </button>
          <input
            className="music-range music-vol-slider"
            type="range"
            min={0}
            max={100}
            step={1}
            value={volume}
            aria-label="Volume"
            onChange={(e) => setVolumeAndPersist(Number(e.target.value))}
          />
          <span className="music-vol-pct">{muted || volume === 0 ? '0' : volume}%</span>
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
              <button className="music-btn" onClick={() => step(-1)} disabled={!canControl} aria-label="Previous track">
                <IconPrev />
              </button>
              <button
                className="music-btn music-play"
                onClick={togglePlay}
                disabled={!canControl}
                aria-label={music?.playing ? 'Pause' : 'Play'}
              >
                {music?.playing ? <IconPause /> : <IconPlay />}
              </button>
              <button className="music-btn" onClick={() => step(1)} disabled={!canControl} aria-label="Next track">
                <IconNext />
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
                    <button className="music-dj-x" onClick={() => toggleDJ(uid)} title="Revoke DJ" aria-label={`Revoke DJ for ${nameFor(uid)}`}>
                      <IconX />
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
        {playbackError && <div className="music-status-error">{playbackError}</div>}
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
        onEnded={() => {
          const m = getMusic()
          if (!m?.currentTrackId) return
          const queue = m.queue.length ? m.queue : tracks.map((t) => t.id)
          const idx = queue.indexOf(m.currentTrackId)
          if (queue.length === 0 || idx < 0) return
          const next = queue[(idx + 1) % queue.length]
          if (next) playTrack(next)
        }}
      />
    </aside>
  )
}