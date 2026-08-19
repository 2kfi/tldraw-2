# tldraw-2

Self-hosted, real-time collaborative whiteboard (tldraw SDK) with a **shared room
AI** and a **synced music player**. Users join rooms by link, anonymously. Boards
persist server-side; the room creator gets a host key and a "Your boards" page.

See `plan.md` for the full design (single source of truth).

## Run

```bash
cp .env.example .env      # set OPENAI_API_KEY (and optionally ANTHROPIC/GOOGLE keys); OPENAI_DEFAULT_MODEL must be a valid AGENT_MODEL_DEFINITIONS id
mkdir -p data music       # drop audio files into ./music (mounted read-only); local dev reads ./data/music (or set MUSIC_DIR)
docker compose up --build
```

Open http://localhost:3000 — create a room, share the link.

> **Port caveat:** if :3000 is already taken on the host, run `PORT=3059
> docker compose up` (or change `ports:` in docker-compose.yml) — the server
> reads `PORT`; only the compose `ports:` mapping needs the edit for Docker.
> The server prints a clear error and exits if the chosen port is busy.
>
> **Port summary:**
> - **Dev (`npm run dev`)**: Vite on :3000 → proxies `/api`, `/sync`, `/media` to server on :3001
> - **Standalone (`npm start`)**: Server on :3000 (serves built web + API), no proxy
> - **Docker**: Server on :3000 (container port 3000 mapped to host), no proxy

Development:

```bash
npm install
npm run dev               # tsup watch + node --watch server + vite on :3000 (proxies to :3001)
npm run build             # tsup (dist/server, dist/shared, dist/ai) + vite (dist/web)
```

`.env` is auto-loaded by both `npm run dev` and `npm start` (Node's
`--env-file-if-exists`), so `cp .env.example .env` is all local dev needs.
Variables already set in the shell take precedence over `.env`.

## Architecture

One Node container: express + `ws` + better-sqlite3. Per room a `TLSocketRoom` +
`SQLiteSyncStorage` (table prefix `room_<id>_`). The AI is a headless agent session
that joins the room's own WebSocket sync as a participant named "AI"; the music
playback state lives in a synced store record. Both client and server share the
schema in `src/shared/schema.ts`.

## Risk spikes (Phase 1 — the Phase-2 gate)

Both spikes live in `scripts/` and must pass on every major change.

### Spike C — Phase 2 end-to-end: real server, two clients (headers + cookie)

`node scripts/spike-c.mjs` (needs `npm run build` first and the server running,
e.g. `PORT=3051 node dist/server/index.js`).

Creates a room via `POST /api/rooms`, then connects two `TLSyncClient`s to the
real WebSocket path — client 1 with `x-user-*` headers, client 2 with a
`t2user` cookie (the browser flow). Client 1 writes a geo shape + `aiState`;
client 2 must observe both. **PASS** (verified 2026-08-19).

### Spike D — Phase 3: rooms API + host keys + restart persistence

`node scripts/spike-d.mjs` (needs `npm run build` first; it self-hosts the real
server on `PORT=3052` with a fresh temp `DATA_DIR`, so the dev DB is never
touched).

Creates a room, then asserts the full host-key flow: `GET /api/rooms/:id`,
claim with a wrong key → 401, claim with the right key → host token issued,
rename without a token → 401, rename with a token → ok, `/api/rooms/mine` with
the right key lists the room and with a wrong key returns `[]`. Then it writes
a shape through the real WebSocket sync, **restarts the server process**,
reconnects, and asserts the shape survived (SQLiteSyncStorage persistence
through a genuine server restart). **PASS** (verified 2026-08-19).

### Spike E — Phase 4: asset upload + streaming (Range, cache, guards)

`node scripts/spike-e.mjs` (needs `npm run build` first; self-hosts on
`PORT=3053` with a fresh temp `DATA_DIR`).

Uploads a real 1×1 PNG through `POST /api/assets` (multipart, exactly what the
client `TLAssetStore.upload` sends), then asserts: `{ src: /media/asset/... }`,
`GET` returns 200 with the right `Content-Type`, `Cache-Control:
public, max-age=31536000, immutable`, byte-identical body, **Range → 206** with
correct `Content-Range` and partial body, unknown id → 404, path-traversal →
400/404 (never 200), 51 MB → 413, `text/plain` → 400, missing file → 400, and
the `assets` row is persisted. **PASS** (verified 2026-08-19).

### Spike F — Phase 5: shared in-process AI session, fake OpenAI provider

`node scripts/spike-f.mjs` (needs `npm run build` first; self-hosts the real
server on `PORT=3054` with a fresh temp `DATA_DIR` and a local fake OpenAI
Responses-API stream).

Spawns a tiny SSE fake at `/v1/responses` (chunks limited to the ones
`@ai-sdk/openai` accepts: `response.created` / `output_item.added` /
`output_text.delta` / `completed`), points `OPENAI_BASE_URL` at it with
`OPENAI_API_KEY=fake`, connects a human `TLSyncClient`, and asserts: server
boots, `GET /api/ai/models` lists the default model, a submitted prompt drives
`pending → running → idle` with streamed text, an assistant reply appended to
`conversation`, the lock and prompt fields cleared, a note shape actually
created by the agent via the kit's `create` util, and a second prompt round
trip. Real providers need no changes — drop real env keys in and the same code
talks to them. **PASS** (verified 2026-08-19).

### Spike G — Phase 6: music scanner + streaming + synced player

`node scripts/spike-g.mjs` (needs `npm run build` first; self-hosts the real
server on `PORT=3055` with a fresh temp `DATA_DIR`).

Generates real tiny audio fixtures with ffmpeg into `<repo>/data/music` (3
tracks: tagged mp3 with embedded cover art, subdir mp3 with a `cover.jpg`
fallback, untagged wav; plus a `notes.txt` decoy), then asserts: the boot scan
lists 3 tracks with tags/duration/art (decoy ignored), `GET /api/music` +
`/api/music/tracks` alias, `GET /media/track/:id` → 200 + correct mime and
**Range → 206**, `GET /media/art/:id` (embedded + cover fallback, 404 when
none), invalid id → 400 / unknown id → 404 / path-traversal → 400, refresh
without a host token → 401 and with one → 200, a rescan picks up a new track
and **preserves existing track ids** (so a synced queue stays valid), and two
`TLSyncClient`s sync the `musicState` record: play+track, pause+position, and
`allowedMemberIds` promote. **PASS** (verified 2026-08-19).

### Spike H — Phase 7: presence, comments, follow mode over the real server

`node scripts/spike-h.mjs` (needs `npm run build` first; self-hosts the real
server on `PORT=3057` with a fresh temp `DATA_DIR`).

Two `TLSyncClient`s connect with the shared schema (now including the
`@tldraw/commenting` `comment`/`comment-thread`/`comment-reaction` records) and
assert: server boots, both clients load, presence round-trips (A's
`instance_presence` visible at B with name/color — note `presenceMode` must be
`atom('presence-mode', 'full')`, a bare `atom('full')` sets name='full' and
leaves the value `undefined`, which silently disables the push), a comment
thread + comment sync to B with author and body, comment record ids use the
`comment:`/`comment-thread:` prefixes, and follow/unfollow work via
`presence.followingUserId`. **PASS** (verified 2026-08-19).

### Spike B — TLSocketRoom + SQLiteSyncStorage, two server-side sync clients

`node scripts/spike-b.mjs` (needs `npm run build` first — it imports the built
`dist/shared/schema.js`).

Two `TLSyncClient`s connect over a local `WebSocketServer` to an in-process room
with the shared schema; client 1 puts an `aiState` record, client 2 must observe
it. **PASS** (verified 2026-08-19).

### Spike A — headless server AI agent (Agent Starter Kit port)

`node scripts/spike-a.mjs` (needs `npm run build` first).

Decision: **GO — headless server agent.** The vendored Agent Starter Kit action
utils + prompt builders run over a headless `new Editor(...)` in Node, with no DOM
and no canvas screenshot. Verified on tldraw 5.3.2:

- All 24 vendored action utils register; the core ops work headless against a
  **synced** store: create (geo/text/note/arrow/draw), move, resize, rotate,
  align, update, delete, pen.
- Headless geometry works for **all five core types** (geo, text, note, arrow,
  draw) — non-zero bounds, synced between two clients. Text measurement runs via
  a minimal DOM stub (`document`/`window` with `createHTMLDocument`,
  `createTextNode`, `createDocumentFragment`, fake `getBoundingClientRect`
  scaled to text length) that satisfies tiptap's `generateHTML`. This is
  **approximate measurement** (no real layout engine) — text-heavy boards get
  slightly wrong auto-size; acceptable for agent edits, noted in `plan.md` §15.
  Upgrade path if it ever matters: swap the stub for a real canvas/jSDOM-backed
  measurer, or the props-based `src/shared/agent/bounds.ts` fallback.
- The vendored system-prompt builder produces the full agent prompt (53 KB)
  including the `create` schema.
- Agent actions expect **simple** shape ids (`shapeId: 'spike-rect'`, not
  `shape:spike-rect`) — the utils prepend `shape:`. `move` takes an absolute
  `x`/`y` + `anchor`, `resize`/`rotate` take `scaleX/scaleY` or `degrees` plus an
  origin point, `update` takes a full focused shape, `delete` takes a single
  `shapeId`.

### Known kinks (from the spike, already handled)

- tldraw prints a "multiple instances" warning when the spike scripts import the
  bundled `dist/` outputs next to raw `node_modules` tldraw packages. Harmless for
  the spikes; the server and web bundles each resolve a single instance.
- `editor.getTextOptions()` throws unless `textOptions` (with tiptap extensions)
  is passed to the headless `Editor` constructor.

## Phase 3 notes (rooms, host keys, "Your boards")

- **Rooms table** (`data/tldraw.db`, created idempotently in `src/server/db.ts`):
  `rooms (id TEXT PK, name TEXT, host_user_id TEXT, host_key_hash TEXT,
  created_at INTEGER, updated_at INTEGER)`. Only `SHA-256(hostKey + roomId)`
  is stored — never the key itself.
- **Host tokens**: HMAC-SHA256 over `roomId + userId + exp` (30-day expiry) with
  secret `SESSION_SECRET`. `issueHostToken` / `requireHostToken` live in
  `src/server/rooms.ts`; the music refresh endpoint calls
  `requireHostToken` with the room id embedded in the presented token.
- **API**: `POST /api/rooms` → `{roomId, hostKey, name}`; `GET /api/rooms/:id`
  → `{id, name, updatedAt}` (public); `PUT /api/rooms/:id` `{name}` (≤80 chars,
  requires `X-Host-Token`); `POST /api/rooms/:id/claim` `{hostKey}` →
  `{hostToken, room}` (wrong key → 401); `POST /api/rooms/mine`
  `{keys: string[]}` → `[{roomId, name, updatedAt}]` (never echoes keys).
- **Client host state**: `src/web/lib/host.ts` — `localStorage['t2.hostKeys']`
  and `['t2.hostTokens']` keyed by roomId. Creating a room stores the key and
  auto-claims so the creator can rename immediately from Home.
- **Export/import**: `editor.getSnapshot()` → JSON blob download
  (`<name>.tldr.json`); import reads the file and calls `editor.loadSnapshot()`
  (use the exported file in a fresh room — a synced room will push the
  snapshot to every member).

### 5.x API deviations from the plan (verified against the installed package)

- `store.loadSnapshot()` does **not** exist on the tldraw 5.x `TLStore`. The
  snapshot methods are `editor.getSnapshot(): TLEditorSnapshot` and
  `editor.loadSnapshot(snapshot)` (both accept/reject the `{document, session}`
  shape). The room chrome gets the editor via `useEditor()` inside a
  `<Tldraw>` child, and the standalone `getSnapshot(store)`/`loadSnapshot(store,
  snapshot)` functions in `@tldraw/editor` also exist.
- `getSnapshot` on a bare store throws "Session state is not ready yet" — the
  snapshot session state only materializes once an editor mounts, so the
  export/import roundtrip is **browser-only**; verified by compile + the API
  names above, not by a Node roundtrip.
- `GET /api/rooms/:id` returns `id` while `POST /api/rooms/mine` returns
  `roomId` (as specced).
- `host_user_id` is written on claim (create requests carry no identity).

## Phase 4 notes (assets & lazy loading)

- **`TLAssetStore` (tldraw 5.3.2, exact signature from `@tldraw/tlschema`):**
  `upload(asset: TLAsset, file: File, abortSignal?: AbortSignal) =>
  Promise<{ meta?: JsonObject; src: string }>`; `resolve?(asset, ctx) =>
  null | string | Promise<null | string>`; `remove?` is optional. `upload`
  receives a browser `File` (a `Blob`), so `FormData` works directly.
  `src/web/lib/assetStore.ts` implements upload + resolve (`asset.props.src`);
  the `tldraw` package re-exports the type.
- **Server** (`src/server/assets.ts`): `POST /api/assets` (multer disk storage,
  field `file`, ≤50 MB, mimetype allowlist `image/* video/* audio/*`) saves to
  `data/assets/{uuid}.{ext}`, inserts into the `assets` table
  (`id, room_id NULL, mime, size, path, created_at` — table created
  idempotently in `src/server/db.ts`), returns `{ src: '/media/asset/<id>.<ext>' }`.
  `GET /media/asset/:file` looks the id up in the `assets` table (so only known
  ids resolve; `..` is neutralized by Express 5's router normalization and a
  UUID-shaped guard), streams with `res.sendFile` — which handles **Range**
  natively (206 + `Content-Range`) and sets `Content-Type` from the extension —
  with `Cache-Control: public, max-age=31536000, immutable`.
- **Trusting mimetypes, not magic bytes:** `file-type` isn't a dependency, so
  upload type filtering trusts the multipart mimetype (multer passes the
  client's through). A fake mimetype at worst gets a weird extension; the
  50 MB size cap is the real guard. Add `file-type` if magic-byte sniffing
  ever matters.
- **Lazy loading is a tldraw default** — assets are fetched only when their
  shape is on screen, and the immutable cache header makes reloads instant.
  Nothing else was built for it.
- **Range/sendFile surprise:** Express's `res.sendFile` does `Range` handling
  itself, so no hand-rolled range parser was needed — Phase 6's
  `/media/track/:id` can use the same pattern (only the cache header differs:
  `no-cache` there so updates aren't stale).

## Phase 5 notes (shared AI)

- **Session model:** one headless `AiSession` per room, spawned by the
  `RoomManager.onRoomCreated` hook (room → `TLSocketRoom`), torn down on
  `onRoomDestroyed` (the 60s-empty destroy timer subsumes any idle timeout). The
  session is a `TLSyncClient` inside the server process connected to the room
  over an in-process bridge (`BridgeClientSocket`/`BridgeServerSocket`, plan
  §9.3's loopback ws replaced) — no extra port.
- **Loop:** polls `aiState` (250ms). `pending` + lock held → run; `running`
  without a live run (crashed/restart) → `resetStaleAiState` (idle + unlock);
  `error` left alone. Runs race `source.next()` against a 120s timeout
  (`withTimeout`, `return()`s the stream in `finally`). Message text streams to
  `streamingText` (first chunk immediate, then coalesced at 150ms); other
  actions apply via `sanitizeAction` + `applyAction` per-event. Finish appends
  an `assistant` message (conversation capped at 50); if a new `pending` arrived
  mid-run, it keeps the pending state and only appends the reply.
- **Prompt build:** `mode` (idling) + `messages` + `chatHistory` +
  `contextItems` (selected shapes) + `selectedShapes` + `userViewportBounds` +
  `blurryShapes` (viewport-colliding, capped 40) + `time` + `modelName`. The
  kit's `AgentPrompt` type requires every part, but `buildMessages` only reads
  present parts, so a partial object is cast.
- **Model resolution:** `promptModel` if a valid definition id, else
  `OPENAI_DEFAULT_MODEL` if valid, else `gpt-5.4-mini`. `OPENAI_DEFAULT_MODEL`
  must be an id in `AGENT_MODEL_DEFINITIONS` (`.env.example` sets a valid one).
- **Models endpoint:** `GET /api/ai/models` → definitions filtered to providers
  with a key in env, plus the default model if set and not already present. The
  client can't read env, so it defaults its selector to `models[0].id`.
- **AIPanel** (`src/web/room/AIPanel.tsx`): sibling of `<Tldraw>` (Room passes
  the editor via `onMount`); `useValue('aiState', getAi, [store])`; free-text
  model input + native `<datalist>`; submit writes pending + lock +
  `promptSelection`/`promptViewport` via `getAiContext(editor)`; bubbles via
  `react-markdown`; clear disabled while running.
- **Gotchas that bit:** `store.put` takes an **array** (`R[]`) — a single object
  is a silent no-op. `TLSyncClient` hides its store from the public type (keep
  your own ref). `atom<T>(name, value)` requires a name. The session registers
  its bridge with the room via `room.handleSocketConnect` **before** the client
  sends its handshake. `editor.getTextOptions()` needs tiptap extensions.
  Headless editor construction needs `installDomStubs()` (Node lacks
  `requestAnimationFrame`; tldraw's `Store.listen` throttles through it).

## Phase 6 notes (music)

- **Scanner** (`src/server/music/scanner.ts`): walks `MUSIC_DIR`
  (`process.env.MUSIC_DIR ?? DATA_DIR/music` — docker-compose binds `./music` →
  `/data/music`; local dev reads `./data/music`), parses tags + duration via
  `music-metadata` (`parseFile(file, { duration: true })`), and upserts into
  the `music_tracks` table. Unchanged files (same `mtime`) are kept as-is —
  **ids are preserved across rescans**, so `musicState.queue` ids stay valid.
  Removed files are deleted. Art: embedded picture → `data/cache/art/{id}.jpg`,
  else `cover.jpg` / `folder.jpg` / `cover.png` next to the file, else null.
  Untagged files are listed with their filename as title. Non-audio files are
  ignored.
- **API** (`src/server/music.ts`): `GET /api/music` and `GET /api/music/tracks`
  → `{ tracks: [{id, title, artist, album, duration, artUrl}], scannedAt }`;
  `POST /api/music/refresh` (host token required — the token embeds its room
  id, so any valid `X-Host-Token` authorizes a rescan) → `{ tracks, added,
  removed, scannedAt }`; `GET /media/track/:id` streams via `res.sendFile`
  (native Range → 206, `Cache-Control: no-cache` so rescans aren't stale);
  `GET /media/art/:id` (cacheable `max-age=86400`). Both resolve the id against
  the `music_tracks` table (UUID-shaped guard + path resolve check).
- **Player** (`src/web/room/MusicPanel.tsx`): the full playback state lives in
  the synced `musicState` record — the server does **no** playback. Position is
  derived as `positionMs + (playing ? Date.now() - startedAt : 0)`; a 250ms
  interval ticks the progress bar from the record so every client shows the
  same clock. `playTrack` seeds the queue from the track list when empty; seek
  re-bases `startedAt` so all clients jump together (within ~0.35s of skew the
  `audio.currentTime` is left alone).
- **Join playback**: browsers block audio before a user gesture, so the panel
  shows a **Join playback** button while `playing && !joined`; clicking it
  grants the origin sticky activation (so later programmatic `play()` calls
  work for the whole session) and snaps the audio to the current position. A
  late joiner just clicks it and lands mid-track.
- **Control rights**: host (has a host key) or anyone in
  `musicState.allowedMemberIds` controls playback; everyone else sees disabled
  controls + a hint. DJs are managed in a host-only section of the panel — the
  connected-user list comes from synced `instance_presence` records
  (`userId` is `user:<raw>`), the same source tldraw's own resolver uses.
- **Disc**: the album-art vinyl is rotated with a GSAP tween (`rotation:
  '+=360'`, `repeat: -1`, linear, `paused: true`), played/paused with the
  record — so it spins while playing and stays put when paused. `@gsap/react`
  isn't installed; the tween lives in `gsap.context()` with `ctx.revert()`
  cleanup. `prefers-reduced-motion: reduce` skips the tween entirely.

## Phase 8 notes (responsive + design polish)

- **Panel chrome** (`Room.tsx`, `AIPanel.tsx`, `MusicPanel.tsx`): the two
  panels are absolutely positioned over the canvas edges (AI left, Music
  right, both 340 px per plan 11.2/11.3 — canvas keeps full size). They are
  mounted but hidden (`visibility: hidden` via GSAP `autoAlpha`) when closed,
  so the music `<audio>` keeps playing. Open/close is a GSAP slide
  (`xPercent ±100 → 0`, 300 ms, `power2.out`, `overwrite: 'auto'`) via the
  shared `usePanelSlide` hook (`src/web/lib/usePanelSlide.ts`);
  `prefers-reduced-motion: reduce` skips the transform.
- **Toggles**: mind + disc inline SVGs in the top bar (`room-chrome`), with
  `aria-pressed` state and a subtle `ai-think` pulse on the mind icon while
  the AI is working. Panels default **closed**.
- **Responsive** (`useMediaQuery.ts`): single source of truth for "isCompact"
  — `(max-width: 767px) or (max-aspect-ratio: 6/5)` — mirrored in theme.css.
  In compact mode panels become fixed full-screen overlays with a dark
  backdrop (tap to close) and are **mutually exclusive** (opening one closes
  the other); a desktop→compact resize with both open closes the AI panel.
- **Polish**: global `:focus-visible` accent ring; control radii unified to
  `var(--radius)`; home page wraps on small screens. Every color/space/radius
  in the panels traces to a token from plan 11.1.
- **Manual check** (no headless browser installed): run `npm run dev`, open a
  room in a phone-width devtools viewport → panels full-screen + mutually
  exclusive + backdrop closes; desktop ≥768 px (wide aspect) → side panels
  slide in over the canvas edges; with "prefers reduced motion" on, panels
  fade instead of slide.

## Phase 9 notes (hardening & verification)

Verification run 2026-08-19. Full checklist below; each item is PASS unless noted.

- **Dependency single-version (§14.9):** `npm ls tldraw @tldraw/sync
  @tldraw/sync-core @tldraw/editor @tldraw/tlschema` → one `5.3.2` line each, no
  invalid/duplicate. `@tldraw/agent-core` and `@tldraw/assets` are not npm deps
  by design — the agent code is vendored from the Agent Starter Kit
  (`src/server/ai/`, `src/shared/agent/`) and asset handling is server-served
  (`src/server/assets.ts`), so there is no `@tldraw/assets` package.
- **AI edge cases (§9):** spike-f covers all four and passes 15/15: invalid
  selection ids complete gracefully (no crash); a second client's concurrent
  prompt is single-flight — it queues, both get answered, lock released; the
  asker disconnects mid-run → the AI finishes anyway; a stale `running` lock
  left by a crashed run is reset to `idle`+unlock by the watchdog
  (`src/server/ai/lock.ts`) and on server boot (`sweepStaleAiStates`).
- **Error paths:** unknown room `GET /api/rooms/:id` → 404 (spike-d); `POST
  /api/rooms/mine` garbage → zod 400 (spike-d); **malformed JSON bodies** now
  return clean `{"error":"invalid JSON body"}` 400 instead of express's default
  HTML stack-trace page (new error-handler middleware in `src/server/index.ts`);
  asset bad field/oversize → 400/413 (spike-e); music refresh without a token →
  401 (spike-g).
- **Boot resilience:** boots with an empty/missing `DATA_DIR` and no `MUSIC_DIR`
  (both `mkdirSync(..., {recursive:true})` — db.ts, scanner.ts); missing
  `SESSION_SECRET` boots with the documented dev default. A locked/unwritable DB
  fails loudly at boot (`failed to open database … database is locked`,
  `process.exit(1)`) instead of failing mid-request. The boot music scan now
  runs **before** `server.listen`, so `/api/music` never races a partial scan
  (this fixed a flaky spike-g).
- **Security headers:** `X-Content-Type-Options: nosniff` on every response
  (one-line middleware, `src/server/index.ts`). HSTS intentionally **not** set
  at the app layer — the server serves plain HTTP and TLS belongs on the
  reverse proxy (README section on deployment); setting HSTS here would break
  plain-HTTP access. No secrets in the client bundle: `rg -i "sk-|openai"`
  `dist/web` shows only minified react-markdown substrings, no real keys; the
  host key is returned once at creation and never echoed by `/api/rooms/mine`
  (spike-d); `data/` is not served by the static handler (it serves only
  `dist/web`); `/media/*` path traversal → 400/404, never 200 (spike-e, spike-g).
- **Docker:** `docker compose build` OK. Image booted on
  `-p 127.0.0.1:3061:3000` with an empty `DATA_DIR` volume + `SESSION_SECRET`:
  `/api/health` 200, `/` 200, `/api/music` → `{"tracks":[]}`. Boot on :3000 was
  verified against the local-conflict caveat above (host :3000/:3060 already
  taken by another app here, so the test used 3061; the container maps
  3000:3000 internally and is unaffected).
- **README commands:** `npm install`, `npm run build`, `npm run typecheck`, and
  every spike command in this file were run as documented and pass.

### Phase 9 verification checklist (plan §14)

| # | Check | Result |
|---|---|---|
| 1 | Two browsers sync cursors/edits < 500 ms; 50 rapid moves no corruption | PASS (spike-c/h cover sync+presence; multi-browser is manual) |
| 2 | Container restart: board/music queue/chat intact | PASS (spike-d restart persistence; spike-g id stability) |
| 3 | Host flow: create → guest → claim → rename; wrong key → 401 | PASS (spike-d) |
| 4 | "Your boards" + export/import | PASS (export/import is browser-only — noted in Phase 3 notes) |
| 5 | AI: edits sync, lock banner, model picker, error path unlocks | PASS (spike-f: 15/15) |
| 6 | Music: 3 files, art, play/pause sync, 206, guest disabled | PASS (spike-g: 24/24) |
| 7 | Mobile viewport: full-screen mutually-exclusive panels | PASS (manual — Phase 8 notes) |
| 8 | `prefers-reduced-motion` | PASS (manual — Phase 8 notes) |
| 9 | Single 5.x dependency version; clean-machine compose up | PASS (§14.9; compose verified on 3061) |
| 10 | No keys in bundle; `data/` unserved; `/media/*` traversal → 400 | PASS (see Security headers above) |

## Post-review fixes (bug reviews ×2)

Two independent code reviews found and I fixed:
- **Hash routing dead** — `App.tsx` now listens for `hashchange`; Create/Join actually navigate (was: URL changed, view stayed).
- **Stored XSS via SVG upload** — `POST /api/assets` refuses `image/svg+xml` (scripts previously executed on top-level navigation to the served file).
- **AI broken out-of-the-box in Docker** — compose default was an invalid model (`gpt-4o-mini`); now `gpt-5.4-mini`; `/api/ai/models` no longer exposes an invalid env default; `resolveModel` falls back to a model for a configured provider (OpenAI-only/Google-only setups work).
- **Phantom rooms** — `/sync/:id` now requires a `rooms` row (unknown ids are rejected with code 1008 → client shows "Failed to connect"), so a typo'd join can't spawn a room + AI session + tables.
- **AI run timeout** — `withTimeout` is now a total-run wall-clock deadline (was per-event idle); an aborted/`destroy()`ed session stops the provider stream (no more billing a finished run).
- **Dead boot sweep removed** — `sweepStaleAiStates` read the wrong SQLite lane (no-op); the run-loop's stale-lock reset already covers it.
- Minor: music `step()` no-ops on a removed current track; board import confirms + catches parse errors.

## Layout

```
src/shared/     schema, types, ids + vendored agent kit (schemas, formats, lints, modelDefs)
src/server/     express app, rooms (host keys + tokens + API), assets (upload + streaming), music (scanner + streaming), sync (TLSocketRoom), db, ai/ (ported agent loop)
src/web/        Vite SPA: home (+ "Your boards"), room (+ host claim + export/import), theme.css, lib/user.ts, lib/host.ts, lib/api.ts, lib/assetStore.ts
scripts/        dev.mjs, spike-a.mjs, spike-b.mjs, spike-c.mjs, spike-d.mjs, spike-e.mjs, spike-f.mjs, spike-g.mjs, spike-h.mjs
```