import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import { useValue } from 'tldraw'
import gsap from 'gsap'
import { MUSIC_STATE_ID, createDefaultMusicState } from '../../shared/schema'
import type { MusicState } from '../../shared/schema'
import type { MusicProposal, MusicProposalsResponse, MusicTrackInfo, MusicTracksResponse } from '../../shared/types'
import { api } from '../lib/api'
import { getHostToken, useIsHost } from '../lib/host'
import { useUser } from '../lib/user'
import { usePanelSlide } from '../lib/usePanelSlide'
import { useFocusTrap } from '../lib/useFocusTrap'

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
  // Reactive host check: updates on claim via t2:host-changed/storage.
  const isHost = useIsHost(roomId)
  const panelRef = useRef<HTMLDivElement>(null)
  usePanelSlide(panelRef, 'right', open)
  // Focus trap matches the share modal: Escape closes, Tab wraps, focus
  // returns to the toggle when the panel closes.
  useFocusTrap(panelRef, open, onClose)

  // ponytail: validated at the sync boundary; the store's branded ids don't know
  // custom records, so cast (same pattern as AIPanel).
  const getMusic = () => store.get(MUSIC_STATE_ID as any) as MusicState | undefined
  const putMusic = (state: MusicState) => store.put([state] as any)
  const music = useValue('musicState', getMusic, [store])

  const [joined, setJoined] = useState(false)
  const joinedRef = useRef(joined)
  joinedRef.current = joined
  const [tracks, setTracks] = useState<MusicTrackInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [opError, setOpError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [drag, setDrag] = useState<number | null>(null)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [proposals, setProposals] = useState<MusicProposal[]>([])
  const [proposalsError, setProposalsError] = useState<string | null>(null)
  const [proposing, setProposing] = useState(false)
  const [proposeMsg, setProposeMsg] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const previewRef = useRef<HTMLAudioElement | null>(null)

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

  // apply the local volume to the shared <audio> element and the private
  // preview element; purely per-browser
  useEffect(() => {
    const v = muted ? 0 : volume / 100
    const audio = audioRef.current
    if (audio) audio.volume = v
    if (previewRef.current) previewRef.current.volume = v
  }, [volume, muted])

  // Private audition element: guests preview tracks locally without touching
  // room state. Stops on unmount + when the panel closes (the panel stays
  // mounted and only hides, so close would otherwise leak audio).
  useEffect(() => () => {
    previewRef.current?.pause()
    previewRef.current = null
  }, [])

  useEffect(() => {
    if (!open) {
      previewRef.current?.pause()
      setPreviewId(null)
    }
  }, [open])

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
  // onEnded fires from a stale closure — mirror canControl into a ref so only
  // a current host/DJ advances the room (single writer, drift §4).
  const canControlRef = useRef(canControl)
  canControlRef.current = canControl

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
  const previewTrack = previewId ? trackById.get(previewId) : undefined

  const q = query.trim().toLowerCase()
  const visible = useMemo(
    () => (q ? tracks.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)) : tracks),
    [tracks, q]
  )

  function currentPos(state: MusicState): number {
    if (state.playing && state.startedAt) return state.positionMs + (Date.now() - state.startedAt)
    return state.positionMs
  }

  useEffect(() => {
    let cancelled = false
    api<MusicTracksResponse>('/api/music')
      .then((res) => { if (!cancelled) { setTracks(res.tracks); setLoading(false) } })
      .catch(() => { if (!cancelled) { setTracks([]); setLoading(false) } })
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
    // Drift §4: the 0.35s snap only fires on record changes, so a clock that
    // wanders mid-track is pulled back gently every 5s (1s tolerance).
    const slow = window.setInterval(() => {
      const m = getMusic()
      const audio = audioRef.current
      if (!open || !m?.playing || !joinedRef.current || seekingRef.current || !audio) return
      if (!Number.isFinite(audio.duration)) return
      const pos = currentPos(m) / 1000
      if (Math.abs(audio.currentTime - pos) > 1) audio.currentTime = pos
    }, 5000)
    return () => {
      window.clearInterval(id)
      window.clearInterval(slow)
    }
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
    // play() resumes from the current angle — restart() would snap the disc
    // back to 0° on every pause/resume and panel toggle.
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
        if (audio.paused) audio.play().catch(() => { setPlaybackError('Playback failed — click any track, then press play.'); if (getMusic()?.playing) void op({ op: 'toggle' }) })
      }
    } else {
      audio.pause()
      if (!seekingRef.current && Number.isFinite(audio.duration)) audio.currentTime = pos
    }
  }, [music, joined])

  // All control writes go through PUT /api/music/state: the server checks
  // host-or-DJ, stamps startedAt on its own clock, and applies via updateStore
  // — the TLSync record is a read replica. Never putMusic() control state
  // directly (a 403/409 leaves the record untouched and surfaces opError).
  async function op(body: Record<string, unknown>) {
    const token = getHostToken(roomId)
    try {
      const res = await api<{ state: MusicState }>('/api/music/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Host-Token': token } : {}) },
        body: JSON.stringify({ roomId, ...body }),
      })
      putMusic(res.state)
      setOpError(null)
    } catch (err) {
      setOpError(err instanceof Error ? err.message : 'control failed')
    }
  }

  function playTrack(trackId: string) {
    setPlaybackError(null)
    setJoined(true)
    void op({ op: 'play', trackId })
  }

  function togglePlay() {
    setPlaybackError(null)
    const cur = getMusic()
    if (!cur || (!cur.playing && !cur.currentTrackId)) return
    void op({ op: 'toggle' })
  }

  function step(delta: number) {
    setPlaybackError(null)
    void op({ op: 'step', delta })
  }

  function seekTo(ms: number) {
    void op({ op: 'seek', positionMs: Math.max(0, Math.round(ms)) })
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

  async function loadProposals() {
    const token = getHostToken(roomId)
    if (!token) return
    try {
      const res = await api<MusicProposalsResponse>(`/api/music/proposals?room=${encodeURIComponent(roomId)}`, {
        headers: { 'X-Host-Token': token },
      })
      setProposals(res.proposals)
      setProposalsError(null)
    } catch (err) {
      setProposalsError(err instanceof Error ? err.message : 'could not load suggestions')
    }
  }

  // Hosts load pending guest suggestions whenever the panel opens.
  useEffect(() => {
    if (open && isHost) void loadProposals()
  }, [open, isHost])

  async function reloadTracks() {
    const res = await api<MusicTracksResponse>('/api/music')
    setTracks(res.tracks)
  }

  function refresh() {
    const token = getHostToken(roomId)
    if (!token) return
    setRefreshError(null)
    api<MusicTracksResponse>(`/api/music/refresh?room=${encodeURIComponent(roomId)}`, {
      method: 'POST',
      headers: { 'X-Host-Token': token },
    })
      .then(() => reloadTracks())
      .then(() => loadProposals())
      .catch((err) => setRefreshError(err instanceof Error ? err.message : 'refresh failed'))
  }

  async function uploadFiles(files: FileList | File[]) {
    const token = getHostToken(roomId)
    if (!token) return
    const list = [...files].filter((f) => f.size > 0)
    if (!list.length) return
    setUploading(true)
    setUploadMsg(null)
    try {
      for (const f of list) {
        const fd = new FormData()
        fd.append('file', f)
        await api(`/api/music/upload?room=${encodeURIComponent(roomId)}`, {
          method: 'POST',
          headers: { 'X-Host-Token': token },
          body: fd,
        })
      }
      await reloadTracks()
      setUploadMsg(list.length === 1 ? 'Track added to the library.' : `${list.length} tracks added to the library.`)
    } catch (err) {
      setUploadMsg(err instanceof Error ? err.message : 'upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function proposeFile(f: File | undefined) {
    if (!f || f.size === 0) return
    setProposing(true)
    setProposeMsg(null)
    try {
      const fd = new FormData()
      fd.append('file', f)
      await api('/api/music/propose', { method: 'POST', body: fd })
      setProposeMsg('Sent to the host — it appears in the library once approved.')
    } catch (err) {
      setProposeMsg(err instanceof Error ? err.message : 'suggestion failed')
    } finally {
      setProposing(false)
    }
  }

  async function decideProposal(id: string, approve: boolean) {
    const token = getHostToken(roomId)
    if (!token) return
    setProposalsError(null)
    try {
      await api(`/api/music/proposals/${id}/${approve ? 'approve' : 'reject'}?room=${encodeURIComponent(roomId)}`, {
        method: 'POST',
        headers: { 'X-Host-Token': token },
      })
      await reloadTracks()
      await loadProposals()
    } catch (err) {
      setProposalsError(err instanceof Error ? err.message : 'decision failed')
    }
  }

  function toggleDJ(rawUserId: string) {
    const cur = getMusic() ?? createDefaultMusicState(me.id)
    void op({ op: 'dj', userId: rawUserId, grant: !cur.allowedMemberIds.includes(rawUserId) })
  }

  function togglePreview(t: MusicTrackInfo) {
    let el = previewRef.current
    if (!el) {
      el = new Audio()
      el.preload = 'none'
      el.onended = () => setPreviewId(null)
      previewRef.current = el
    }
    if (previewId === t.id) {
      el.pause()
      setPreviewId(null)
      return
    }
    el.src = `/media/track/${t.id}`
    el.volume = muted ? 0 : volume / 100
    el.play()
      .then(() => setPreviewId(t.id))
      .catch(() => setPlaybackError('Preview failed — try again.'))
  }

  function nameFor(rawUserId: string): string {
    if (rawUserId === me.id) return `${me.name} (you)`
    const p = presences.find((pr) => pr.userId === 'user:' + rawUserId)
    return p?.userName ?? rawUserId.slice(0, 6)
  }

  return (
    <aside className="music-panel" ref={panelRef} aria-label="Music" tabIndex={-1}>
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
              aria-label="Seek position"
              aria-valuetext={`${fmt(drag ?? progress)} of ${fmt(current.duration)}`}
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

        <div className="music-search">
          <input
            className="music-search-input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title, artist, album"
            aria-label="Search tracks"
          />
          {query && (
            <button className="music-btn music-search-clear" onClick={() => setQuery('')} aria-label="Clear search">
              <IconX />
            </button>
          )}
        </div>

        {isHost && (
          <div
            className={`music-drop${dragOver ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); void uploadFiles(e.dataTransfer.files) }}
          >
            <label className="music-drop-label">
              <input
                className="music-drop-input"
                type="file"
                accept="audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav,.aac"
                multiple
                disabled={uploading}
                onChange={(e) => { void uploadFiles(e.target.files ?? []); e.target.value = '' }}
              />
              <span>{uploading ? 'Uploading…' : 'Drop audio here or browse to add it to the library'}</span>
            </label>
            {uploadMsg && <div className="music-hint">{uploadMsg}</div>}
          </div>
        )}

        <div className="music-queue" aria-busy={loading}>
          {loading && (
            <>
              <span className="sr-only" role="status">Loading tracks…</span>
              <div className="music-skeletons" aria-hidden="true">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="music-skeleton">
                    <span className="music-skeleton-line w60" />
                    <span className="music-skeleton-line w40" />
                  </div>
                ))}
              </div>
            </>
          )}
          {!loading && visible.map((t) => {
            const previewing = t.id === previewId
            return (
              <button
                key={t.id}
                className={`music-track${t.id === music?.currentTrackId ? ' active' : ''}${previewing ? ' previewing' : ''}`}
                onClick={() => (canControl ? playTrack(t.id) : togglePreview(t))}
                aria-label={
                  canControl
                    ? `Play ${t.title} in the room`
                    : previewing
                      ? `Stop previewing ${t.title}`
                      : `Preview ${t.title} privately (only you hear this)`
                }
              >
                <span className="music-track-title2">{t.title}</span>
                <span className="music-track-artist2">
                  {[t.artist, t.album].filter(Boolean).join(' · ') || fmt(t.duration)}
                </span>
              </button>
            )
          })}
          {!loading && tracks.length === 0 && (
            <div className="music-empty">
              {isHost
                ? 'No tracks yet — drop audio above to start the library.'
                : 'The library is empty. Suggest a track below and the host can add it.'}
            </div>
          )}
          {!loading && tracks.length > 0 && visible.length === 0 && (
            <div className="music-empty">No tracks match “{query.trim()}”.</div>
          )}
        </div>
        {!canControl && !loading && tracks.length > 0 && (
          <div className="music-hint">Tap a track to preview it privately — only the host or a DJ plays to the room.</div>
        )}
        {previewTrack && (
          <div className="music-hint">Previewing “{previewTrack.title}” privately — only you hear this. Tap it again to stop.</div>
        )}

        {!isHost && (
          <div className="music-suggest">
            <div className="music-djs-title">Suggest a track</div>
            <label className="music-btn music-suggest-label">
              <input
                className="music-drop-input"
                type="file"
                accept="audio/*,.mp3,.m4a,.flac,.ogg,.opus,.wav,.aac"
                disabled={proposing}
                onChange={(e) => { void proposeFile(e.target.files?.[0]); e.target.value = '' }}
              />
              <span>{proposing ? 'Sending…' : 'Choose audio to suggest'}</span>
            </label>
            {proposeMsg && <div className="music-hint">{proposeMsg}</div>}
          </div>
        )}

        {isHost && (
          <div className="music-djs">
            <div className="music-djs-title">
              Suggested tracks{proposals.length > 0 ? ` (${proposals.length})` : ''}
            </div>
            {proposals.length === 0 ? (
              <div className="music-empty">Nothing waiting — guest suggestions will appear here for approval.</div>
            ) : (
              proposals.map((p) => (
                <div key={p.id} className="music-proposal">
                  <span className="music-proposal-name">
                    {p.origName}
                    <span className="music-proposal-by"> · {p.submittedByName}</span>
                  </span>
                  <span className="music-proposal-actions">
                    <button className="music-btn" onClick={() => void decideProposal(p.id, true)}>
                      Approve
                    </button>
                    <button className="music-btn" onClick={() => void decideProposal(p.id, false)}>
                      Reject
                    </button>
                  </span>
                </div>
              ))
            )}
            {proposalsError && <div className="music-status-error">{proposalsError}</div>}
          </div>
        )}

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
        {opError && <div className="music-status-error">{opError}</div>}
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
          // Single writer: only a current host/DJ advances the room. Guests let
          // their audio end and follow the record — every joined client writing
          // here raced and skipped tracks.
          if (!canControlRef.current) return
          void op({ op: 'step', delta: 1 })
        }}
      />
    </aside>
  )
}