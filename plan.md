# tldraw-2 — Collaborative Whiteboard with Shared AI & Room Music

A self-hosted, real-time collaborative whiteboard, built on the open-source tldraw
SDK, with two custom panels: a **shared AI assistant** for the whole room and a
**synced music player** backed by a folder-bound music library. Users join rooms by
link, anonymously. Rooms persist forever server-side; the room creator gets a
**host key** to reclaim their room and a "Your boards" page.

This document is the single source of truth. It explains the product, the
architecture, every technical decision, the exact build steps (phases 1–9), and how
to verify the result. If a phase says "verify X", do not skip it.

---

## 1. Product summary (what we are building, in plain terms)

- A website where people draw together on one infinite whiteboard in real time.
- Like excalidraw.com, but using the open-source **tldraw** SDK as the drawing
  engine, plus two features tldraw doesn't ship:
  1. **AI panel (left, mind icon):** one shared AI per room. Anyone can ask it to
     look at or edit the board ("add a flowchart", "make all notes pink", "summarize
     this board"). Only one person can use it at a time; while in use, everyone else
     sees "Maya is using the AI…" (soft lock).
  2. **Music panel (right, disc icon):** a room jukebox. The server reads audio
     files from a folder bound into Docker. A spinning disc shows the album art.
     The host (and people the host promotes) controls play/pause/skip. Everyone in
     the room hears the same song, approximately in sync.
- Extra tldraw-built-in features kept and enabled: live cursors + names (presence),
  **follow mode**, and **comments**.
- Anonymous access: anyone with a room link joins. No sign-up. The user is an
  auto-generated identity (id + editable name + color) stored in `localStorage`.
- Persistence: every room's document is saved to SQLite on the server continuously;
  nothing is lost on restart.
- "Your boards": the home page lists rooms for which this browser holds a host key
  (rename, copy link, open). Boards can be exported/imported as JSON files.
- Deployment: a single Docker container (Node server). The server serves the SPA,
  the WebSocket sync, the AI, the music, and the uploaded assets.

### Explicitly out of scope (do not build)
- User accounts / email / OAuth / password login.
- tldraw.com-style file/folder management, templates, publishing, billing.
- Moderating abusive content, rate-limit hardening, multi-instance scaling.
  Rooms are "link-secret" like excalidraw: whoever has the link can join; the host
  key is the only authority.

---

## 2. Scope checklist

| Feature | Source | Status |
|---|---|---|
| Infinite canvas with all default tools | tldraw SDK | ✅ core |
| Real-time multiplayer sync | `@tldraw/sync` + `@tldraw/sync-core` | ✅ core |
| Presence: cursors, names, colors, viewports | tldraw sync presence | ✅ core |
| Follow mode | tldraw default UI | ✅ enable + verify (Phase 7) |
| Comments | tldraw comment shape/tool | ✅ enable + verify (Phase 7) |
| Rooms with links, anonymous join | custom server | ✅ core |
| Server-side persistence of boards | SQLite (`SQLiteSyncStorage`) | ✅ core |
| Shared AI per room + soft lock + model picker | Agent Starter Kit (vendored, headless server agent) + AI SDK v5 | ✅ core |
| Music from bound folder + synced playback | custom | ✅ core |
| Host keys + "Your boards" + rename + export/import | custom | ✅ core |
| Lazy image/asset loading | tldraw `TLAssetStore` + server streaming | ✅ core |
| Responsive: mobile panels cover canvas, mutual close | custom | ✅ core |
| Design system (dark, tldraw tokens) + GSAP motion | design skills | ✅ core |

---

## 3. Stack & versions (pinned — do not bump without reading section 3.1)

| Piece | Choice | Version |
|---|---|---|
| tldraw app package | `tldraw` | **^5.3.2** |
| Client sync | `@tldraw/sync` | ^5.3.2 |
| Server sync | `@tldraw/sync-core` | ^5.3.2 |
| Agent core | `@tldraw/agent-core` (from the Agent Starter Kit) | ^5.3.2 |
| AI SDK | `ai` (Vercel AI SDK) | ^5.0.194 |
| OpenAI provider | `@ai-sdk/openai` (any OpenAI-compatible base URL) | ^2.0.106 |
| Anthropic provider (optional) | `@ai-sdk/anthropic` | ^2.0.80 |
| Google provider (optional) | `@ai-sdk/google` | ^2.0.74 |
| Frontend | React 19.2.1 + Vite 8 + TypeScript | per kit |
| Server | Node 22 + express + `ws` + better-sqlite3 | latest |
| Music metadata | `music-metadata` (pure JS, reads ID3/MP4/Vorbis tags + embedded art) | latest |
| Markdown | `react-markdown` (AI chat rendering) | ^10.1.0 |
| Validation | `zod` (request validation + agent schemas) | ^4.1.8 |
| Uploads | `multer` | latest |
| Animation | `gsap` (client) | latest |
| Misc | `nanoid` | latest |

**Rule:** all `@tldraw/*` packages and `tldraw` must resolve to one single version
(5.3.2 line). Verify with `npm ls tldraw @tldraw/sync @tldraw/sync-core` — if npm
pulls mixed versions, add `overrides` in package.json to force the 5.3.2 line.

### 3.1 Why the Agent Starter Kit instead of `@tldraw/ai`
- `@tldraw/ai` is frozen at 3.15.4 (last published 2025-08-28) and depends on
  `tldraw@3.15.4`; the current tldraw major is 5.x. Pinning the whole stack to
  3.15.4 for it is not worth it.
- tldraw's official current AI reference is the **Agent Starter Kit**
  (`github.com/tldraw/agent-template`, scaffolded with
  `npm create tldraw@latest -- --template agent`), which targets **tldraw ^5.3.2**
  and is the same agent stack that powers tldraw.com. It ships:
  - `shared/`: zod `AgentActionSchemas`, `PromptPartDefinitions`, `formats`
    (Blurry / Focused / Peripheral) that decide which shape data the model sees,
    and lints for shape cleanup.
  - `client/agent`: a browser-side `TldrawAgent` + managers, and
    `worker/prompt.ts` (builds the full system+user prompt from the canvas
    snapshot) + `worker/do/AgentService.ts` (the streaming agent loop on a Cloudflare
    Worker + Durable Object).
  - `AGENT_MODEL_DEFINITIONS`: preset model catalog (OpenAI, Anthropic, Google).
- **This project runs the kit's agent loop server-side and headless** (the user's
  decision, 9.6): the browser parts are not used; instead a headless `Editor` in
  Node runs the same actions over a synced store. See section 9 for the full
  adaptation and the Phase-1 spike gate.
- Vendor the needed kit files into `src/` (they are MIT/Apache like the rest of
  tldraw — keep their license headers). Do not `npm install` the whole template;
  it brings a Cloudflare Worker setup we do not use.

### 3.2 Repo layout (single package, one container)

```
tldraw-2/
├── plan.md                     ← this file
├── README.md                   ← run instructions (docker compose up)
├── package.json                ← single package; scripts: dev, build, start
├── tsconfig.json               ← shared TS config (both client and server code)
├── vite.config.ts              ← builds the SPA into dist/web
├── tsup.config.ts              ← builds the server into dist/server
├── Dockerfile                  ← multi-stage: build web + server, run node
├── docker-compose.yml          ← ports, ./data volume, ./music bind, env
├── .env.example                ← documents every env var
├── src/
│   ├── shared/                 ← code imported by BOTH client and server
│   │   ├── schema.ts           ← createTLSchema with custom records (aiState, musicState)
│   │   ├── types.ts            ← shared types (room info, music track, AI record)
│   │   ├── ids.ts              ← nanoid helpers, room id alphabet
│   │   └── agent/              ← vendored Agent Starter Kit shared code
│   │       ├── schemas.ts      ← AgentActionSchemas (zod)
│   │       ├── prompts.ts      ← PromptPartDefinitions
│   │       ├── formats.ts      ← Blurry/Focused/Peripheral formats
│   │       ├── lints.ts        ← shape cleanup lints
│   │       ├── modelDefs.ts    ← AGENT_MODEL_DEFINITIONS
│   │       └── bounds.ts       ← headless bounds util (props-based fallback)
│   ├── server/
│   │   ├── index.ts            ← entry: express app + http server + ws upgrade routing
│   │   ├── config.ts           ← reads env, zod-validated
│   │   ├── db.ts               ← better-sqlite3 singleton + schema creation
│   │   ├── rooms.ts            ← room CRUD, host keys, "Your boards" API
│   │   ├── sync.ts             ← TLSocketRoom per room + SQLiteSyncStorage wiring
│   │   ├── assets.ts           ← TLAssetStore server side: upload + streaming
│   │   ├── music/
│   │   │   ├── scanner.ts      ← folder walk + tag parsing + art extraction
│   │   │   └── player.ts       ← playback state helpers (not an audio device; state only)
│   │   └── ai/
│   │       ├── models.ts       ← model list from modelDefs + env config
│   │       ├── sessions.ts     ← per-room agent session lifecycle + lock management
│   │       ├── agent-loop.ts   ← port of kit client/agent: TldrawAgent + managers over a headless Editor
│   │       ├── prompt.ts       ← port of kit worker/prompt (headless prompt builder)
│   │       ├── service.ts      ← port of kit worker/do/AgentService: streaming loop, express route (no Durable Object)
│   │       └── lock.ts         ← stale-lock watchdog
│   └── web/
│       ├── main.tsx            ← React root
│       ├── App.tsx             ← router: "/" (home) and "/r/:roomId" (room)
│       ├── lib/
│       │   ├── user.ts         ← anonymous identity in localStorage
│       │   ├── host.ts         ← host keys + host tokens in localStorage
│       │   ├── api.ts          ← fetch helpers for server APIs
│       │   ├── assetStore.ts   ← client TLAssetStore (upload + resolve URLs)
│       │   └── theme.css       ← design tokens (section 11)
│       ├── home/Home.tsx       ← create room, join by link, "Your boards" list
│       └── room/
│           ├── Room.tsx        ← <Tldraw> + panels + user identity + host claim
│           ├── aiContext.ts    ← gather selection + viewport bounds, send with prompt
│           ├── AIPanel.tsx     ← chat UI, model picker, lock indicator
│           ├── MusicPanel.tsx  ← track list, disc player, controls
│           └── panels.css      ← panel styles, disc spin, GSAP hooks
└── data/                       ← runtime volume (created by compose): sqlite + assets + art cache
```

---

## 4. Architecture overview

```
Browser (SPA, React 19, tldraw 5.x)
  │
  │  GET /                 → SPA (static files)
  │  WS   /sync/:roomId    → @tldraw/sync client (useSync) — the ONLY canvas sync path
  │  POST /api/rooms...    → rooms, host keys, "Your boards"
  │  GET  /media/asset/:file  → uploaded images/video (lazy, cache headers, Range)
  │  POST /api/assets      → image/video upload (multipart)
  │  GET  /media/track/:id → audio streaming (Range → seekable)
  │  GET  /api/music       → library list, queue ops (mutations also via room store)
  │  GET  /api/ai/models   → model list (modelDefs + env); prompts go through room store, not REST
  ▼
Node 22 server (express + ws + better-sqlite3)
  ├─ sync.ts      TLSocketRoom per room (created lazily on first WS connect),
  │               persisted by SQLiteSyncStorage (one db file, per-room table prefix)
  ├─ ai/          ONE headless agent session per room, spawned on demand. The
  │               session is itself a sync client: it connects to
  │               ws://localhost:PORT/sync/:roomId as a participant named "AI".
  │               It watches the shared store for pending prompts, runs the
  │               Agent Starter Kit loop (ported, headless Editor) against its
  │               synced store, and writes edits + chat text back through the room.
  ├─ music/       scans ./data/music (bind-mounted ./music), parses tags, extracts
  │               art to ./data/cache/art, streams files with Range support.
  │               Playback STATE lives in the room store (record musicState).
  └─ rooms.ts     rooms + host keys in SQLite; HMAC-signed host tokens (stateless).
```

**Key insight (why the AI is "shared" for free):** the AI session is just another
member of the room. It reads and writes through the same WebSocket sync every user
uses, so its edits appear on every canvas instantly and it always sees the live
document. No AI-specific canvas transport is needed.

**Key insight (music sync):** playback state (current track, playing, start
timestamp, queue, allowed members) is a synced store record. Each client plays its
own `<audio>` stream of the track and seeks to `positionMs + (now − startedAt)`.
Drift of a few hundred ms is accepted (it is a room jukebox, not a DAW).

---

## 5. Data model

### 5.1 SQLite (server, `data/app.db`)

| Table | Columns | Notes |
|---|---|---|
| `rooms` | `id TEXT PK` (nanoid 10), `name TEXT`, `host_user_id TEXT`, `host_key_hash TEXT`, `created_at INTEGER`, `updated_at INTEGER` | host_key_hash = SHA-256(hostKey + roomId), stored only as hash |
| `assets` | `id TEXT PK` (uuid), `room_id TEXT`, `mime TEXT`, `size INTEGER`, `path TEXT`, `created_at` | files live in `data/assets/{id}.{ext}` |
| `music_tracks` | `id TEXT PK` (uuid), `rel_path TEXT UNIQUE`, `title`, `artist`, `album`, `duration REAL`, `art_path TEXT NULL`, `mtime INTEGER` | rescanned on startup + refresh; mtime used to detect changes |
| tldraw sync tables | created by `SQLiteSyncStorage` per room with `tablePrefix = 'room_<id>_'` | do not touch directly |

### 5.2 Custom tldraw store records (in `src/shared/schema.ts`)

Both client and server import this exact schema. Created with
`createTLSchema({ shapes: {}, bindings: {}, records: { aiState, musicState } })`
and `createRecordType('aiState', { scope: 'document', ephemeral: false })` etc.
`scope: 'document'` = synced to everyone AND persisted. Validate props with `T.*`
validators from `@tldraw/validate` (or `@tldraw/tlschema` re-exports).

**`aiState`** (single record, id `'ai:global'`):
```ts
{
  lockedBy: string | null,      // userId of the human currently using the AI
  lockedByName: string | null,  // their display name (for "X is using the AI…")
  status: 'idle' | 'pending' | 'running' | 'error',
  streamingText: string,        // live token accumulation (throttled writes)
  conversation: Array<{ role: 'user' | 'assistant', content: string }>, // capped at 50 msgs
  error: string | null,         // last error message
  prompt: string | null,        // pending/running prompt text (set on submit)
  promptModel: string | null,   // model chosen by the asker (9.4)
  promptSelection: string[] | null, // shape ids the asker had selected (9.2)
  promptViewport: { x: number; y: number; w: number; h: number } | null, // asker viewport bounds (9.2)
}
```

**`musicState`** (single record, id `'music:global'`):
```ts
{
  currentTrackId: string | null,
  playing: boolean,
  startedAt: number | null,     // epoch ms when playback started (null when paused)
  positionMs: number,           // captured offset at pause/change
  queue: string[],              // ordered track ids
  allowedMemberIds: string[],   // guests the host promoted to control music
  updatedBy: string,            // userId that made the last change
}
```
`positionMs`/`startedAt` semantics: local playback position =
`positionMs + (playing ? Date.now() − startedAt : 0)`.

### 5.3 Anonymous users
- `userId`: `crypto.randomUUID()` stored in `localStorage['t2.userId']`.
- Name: random from a small adjective+noun list; editable in a top-bar menu.
- Color: random from tldraw's palette; editable.
- Passed to `useSync({ userInfo: { id, name, color } })`.

### 5.4 Host identity
- On room creation, server generates `hostKey` (32 random bytes, base62) and returns
  it once. Client stores `localStorage['t2.hostKeys'][roomId] = hostKey`.
- Host key grants: rename room, promote members, music control if not already
  allowed. **Reclaim:** button in room "Claim host" → pastes hostKey →
  `POST /api/rooms/:id/claim` → server verifies hash, returns a signed host token
  (HMAC-SHA256 over `roomId + userId + exp`, secret `SESSION_SECRET`, 30 days),
  stored in localStorage. All host APIs require header `X-Host-Token`.
- Guests: no token, but they can draw (it is collaborative); only **management
  powers** require host (rename, music control, promotion).

---

## 6. Server API surface

All JSON. Errors: `{ error: string }` with proper status codes.

| Method/Path | Auth | Purpose |
|---|---|---|
| `POST /api/rooms` `{name?}` | none | Create room → `{ roomId, hostKey }` |
| `GET /api/rooms/:id` | none | Public room info `{id, name, updatedAt}` |
| `PUT /api/rooms/:id` `{name}` | host token | Rename (≤80 chars) |
| `POST /api/rooms/:id/claim` `{hostKey}` | none | Verify key → `{ hostToken, room }` |
| `POST /api/rooms/mine` `{keys: string[]}` | none | Batch check which local host keys are valid → `[{roomId, name, updatedAt}]` (for "Your boards"; do not echo keys back) |
| `POST /api/assets` (multipart `file`) | none | Upload image/video/audio → `{ src: '/media/asset/<uuid>.<ext>' }`; limits: ≤50 MB, allowlist `image/* video/* audio/*` |
| `GET /media/asset/:file` | none | Stream asset; `Cache-Control: public, max-age=31536000, immutable`; Range support |
| `GET /api/music` | none | `{ tracks: [{id,title,artist,album,duration,artUrl}], scannedAt }` |
| `GET /media/track/:id` | none | Stream audio; Range support (needed for seek); `Cache-Control: no-cache` |
| `POST /api/music/refresh` | host token | Rescan the folder now |
| `GET /api/ai/models` | none | List models from `AGENT_MODEL_DEFINITIONS` filtered to configured providers + `OPENAI_DEFAULT_MODEL` fallback |

Play/pause/skip/promote are **not** REST — they are writes to the `musicState`
record through the room store (so every client updates instantly). REST only serves
the library list and refresh.

---

## 7. Sync subsystem (phases 1–2)

### 7.1 Server (`src/server/sync.ts`)
- `ws` server attached to the same HTTP server, upgrade only on `/sync/:roomId`.
- Room registry: `Map<roomId, TLSocketRoom>`; create lazily on first connection.
- One shared `better-sqlite3` db; per room:
  `new SQLiteSyncStorage({ sql: adapter, tablePrefix: 'room_' + roomId + '_' })`
  where `adapter` wraps better-sqlite3 with the minimal `{ exec, run, get, all }`
  interface expected by `@tldraw/sync-core` (confirm exact interface shape from the
  package source during Phase 2 — it must run synchronously).
- Room opts: `schema` (shared), `clientTimeout: 30_000`.
- On WS connect: `room.handleSocketConnect(ws, { sessionId: uuid, userId, userInfo: {id,name,color} })`.
- Wire `ws` message/close/error events to `room.handleSocketMessage/close/error`.
- Track connection count per room; close+delete TLSocketRoom when empty (snapshot
  is already persisted by SQLiteSyncStorage on every change).
- **Persistence caveat:** `SQLiteSyncStorage` persists continuously, so nothing
  extra is needed; on server start, rooms materialize from their tables.

### 7.2 Client (`src/web/room/Room.tsx`)
```ts
const store = useSync({
  schema,                       // from src/shared/schema.ts
  uri: `/sync/${roomId}`,
  userInfo: { id, name, color },
  assets: clientAssetStore,     // section 8
})
// store.status: 'loading' | 'error' | 'ready' → render spinner / error / <Tldraw store={store.store}>
```
- `useSync` reconnects automatically; show tldraw's offline indicator.
- **Multi-tab caution:** two tabs of the same browser are two users; acceptable.

### 7.3 Reacting to custom records
- `useSyncExternalStore`-style helper or `store.useStore()` from `@tldraw/store` to
  subscribe to `aiState`/`musicState` records; write via `store.put([record])`.
- Writes from any client sync to everyone; server workers see them too (they are
  sync clients). One write-path for everything — no HTTP for canvas state.

---

## 8. Assets & lazy loading (Phase 4)

tldraw loads image/video asset contents lazily (only when the shape is on screen).
We only provide the plumbing:

- Server `TLAssetStore` (i.e. the `/api/assets` + `/media/asset/*` endpoints in
  section 6). Save uploads to `data/assets/{uuid}.{ext}`; store metadata in the
  `assets` table; stream with long cache headers + Range.
- Client `src/web/lib/assetStore.ts` implements `TLAssetStore`:
  - `upload(asset, file)` → `FormData` POST to `/api/assets` → return `{ src }`.
  - `resolve(asset)` → `asset.props.src` (the URL already points at our server).
- That's it — lazy streaming, cache headers, and image shape rendering are tldraw
  defaults. Nothing else to build for "lazy loading".

---

## 9. AI subsystem (Phase 5) — Agent Starter Kit, headless server agent

### 9.1 Source of truth
Vendor the Agent Starter Kit (`npm create tldraw@latest -- --template agent`,
github.com/tldraw/agent-template) into `src/` per the layout in 3.2. Read the
kit's own `README` and `tldraw.dev/starter-kits/agent` before touching it, then
port:

| Kit file | Port to | Adaptation |
|---|---|---|
| `shared/agent/AgentActionSchemas.ts` | `src/shared/agent/schemas.ts` | unchanged |
| `shared/agent/PromptPartDefinitions.ts` | `src/shared/agent/prompts.ts` | unchanged |
| `shared/agent/Formats.ts` | `src/shared/agent/formats.ts` | unchanged |
| `shared/agent/Lints.ts` | `src/shared/agent/lints.ts` | unchanged |
| `shared/agent/AGENT_MODEL_DEFINITIONS.ts` | `src/shared/agent/modelDefs.ts` | filter by configured providers |
| `client/agent/*` (TldrawAgent, managers) | `src/server/ai/agent-loop.ts` | **headless**: no DOM, no screenshot tool, no client-side hooks; runs against a headless `Editor` over the synced store |
| `worker/prompt.ts` (prompt builder) | `src/server/ai/prompt.ts` | headless prompt parts (9.2) |
| `worker/do/AgentService.ts` | `src/server/ai/service.ts` | same streaming loop, but an express POST route instead of a Durable Object; per-room session (9.3) |

Keep the kit's license headers. Re-check upstream on each tldraw bump (see 15).

### 9.2 Headless prompt — what the model sees
The kit's browser agent captures the canvas as an image and lets the model read
shape data. A headless server agent cannot capture pixels, so the prompt builder
(`prompt.ts`) assembles the parts **from structured shape data only**:
- Context parts from `src/web/room/aiContext.ts`: the asker's **selection**
  (shape ids) and **viewport bounds** are sent with the prompt and stored in
  `aiState`; the server resolves them against the synced store.
- All format types (Blurry / Focused / Peripheral) and lints are kept as-is — they
  already read `TLSchema`-typed records, which is exactly what a headless store
  holds. Only the prompt-parts that embed canvas pixels are dropped.
- Geometry helper: the kit's bounds/geometry may need DOM text measurement. If it
  fails headless, `src/shared/agent/bounds.ts` is a props-based fallback
  (x/y/w/h from props; draw = min/max over points) — decided in Spike A (9.6).

### 9.3 Session lifecycle (`src/server/ai/sessions.ts`)
- A `Map<roomId, Session>`; `getOrCreate(roomId)` spawns the session on the first
  pending prompt. The session is a sync client (loopback
  `ws://localhost:PORT/sync/:roomId`, `userInfo: { id: 'ai', name: 'AI' }`) plus a
  headless `Editor` over its synced store. When the editor is ready, the session
  owns `aiState` and can run agent actions.
- Prompt execution calls the ported `AgentService` loop **in-process**
  (`service.ts`, ported from `worker/do/AgentService` — no HTTP hop needed since
  the session lives on the same server): the loop streams model text tokens into
  `aiState.streamingText` (throttle: write at most every ~150 ms) and executes
  agent actions against the headless editor; every edit lands in the shared store
  and reaches all canvases through the normal sync path.
- Single-flight loop:
  1. Wait until store has `aiState.status === 'pending'` (with `prompt`,
     `promptModel`, `promptSelection`, `promptViewport`).
  2. Set `status: 'running'` (the lock is now owned by the AI; the asking user may
     leave — the AI keeps going).
  3. Run the agent (9.4) with the prompt + context from 9.2.
  4. On finish: append assistant message to `conversation` (capped at 50),
     clear `streamingText`, set `status: 'idle'`, `lockedBy: null`,
     `lockedByName: null`.
  5. On error/timeout (AI run timeout 120 s): `status: 'error'`, set `error`,
     unlock.
- **Stale-lock watchdog (`lock.ts`):** on session start and on server boot, if
  `status === 'running'` with no active agent, reset to `idle`.
- Session idle timeout: destroy 30 min after last prompt (connection closes;
  nothing persists beyond the store).

### 9.4 Models
- `GET /api/ai/models` returns `AGENT_MODEL_DEFINITIONS` filtered to the providers
  with a key configured (env), plus `OPENAI_DEFAULT_MODEL` as fallback.
- The panel dropdown lists those; free-text input allows any model id. Selected
  model stored per-user in localStorage; sent with each prompt via the `aiState`
  record (`promptModel`); defaults to `OPENAI_DEFAULT_MODEL`.

### 9.5 Soft-lock UX (client, `AIPanel.tsx`)
- Input disabled + placeholder "X is using the AI…" whenever
  `lockedBy !== null && lockedBy !== me`.
- Submit: if idle → set `lockedBy: me`, `lockedByName: myName`,
  `status: 'pending'`, append user message, attach `promptSelection` +
  `promptViewport` from `aiContext.ts` (asker's selection + viewport bounds).
- While `status === 'running'`: show live `streamingText` with a typing cursor and
  an "AI is thinking…" indicator.
- Conversation rendered as chat bubbles with `react-markdown` (kit dependency).
- Action cards (from the kit's `Formats`/action records) while running, e.g.
  "adding 3 shapes…" if the agent exposes progress.
- "Clear conversation" button (anyone; it is a room-level chat — add a confirm).

### 9.6 Spike A (Phase 1 gate) — decide: headless GO or fallback
Before Phase 2, run and document in the README:
1. Scaffold the kit (`npm create tldraw@latest -- --template agent`) — sanity:
   the kit agent runs in the browser against tldraw ^5.3.2 (the kit's own stack).
2. Headless `new Editor({ store, shapeUtils: defaultShapeUtils, tools: [],
   getContainer: () => stub })` in Node over a **synced** store (after Spike B is
   wired): all agent ops must work without a DOM — create/update/delete/move/
   resize/align shapes, read records, run lints.
3. Headless bounds/geometry for geo, text, note, arrow, draw shapes; if text
   measurement fails, use `shared/agent/bounds.ts` (props-based).
4. Port `worker/prompt` + `AgentService` to express with streaming through
   `@ai-sdk/openai` honoring `OPENAI_BASE_URL` (works against any OpenAI-
   compatible endpoint).
5. Record the decision: **headless server agent GO** (preferred) or a documented
   fallback (e.g. run the kit's browser agent but keep the lock/lifecycle
   server-side; or hand-rolled store-only tools). Whatever the choice, section 9
   is updated to match before Phase 2 starts.

---

## 10. Music subsystem (Phase 6)

### 10.1 Library from a bound folder
- `docker-compose.yml`: `./music:/data/music:ro`. The host drops songs into
  `./music`; no upload UI.
- `scanner.ts` walks recursively for `mp3, m4a, flac, ogg, opus, wav, aac`.
- For each file: `parseFile(path)` from `music-metadata` →
  `{ common: { title, artist, album, picture: [{ format, data }] }, format: { duration } }`.
  Title fallback: filename minus extension.
- Upsert into `music_tracks` keyed by `rel_path`; skip if `mtime` unchanged.
- **Art resolution order:** (1) embedded picture → write to
  `data/cache/art/{trackId}.jpg` (this is why `data/` must be writable even though
  `music/` is read-only); (2) `cover.jpg`/`folder.jpg`/`cover.png` in the same dir
  as the file; (3) `artUrl: null` → panel shows a default vinyl graphic.
- Scan runs on server start and on `POST /api/music/refresh`. (Optional: `fs.watch`
  on the music dir with a 2 s debounce — nice-to-have; skip if time-boxed.)

### 10.2 Playback control (state in the room store)
- Permissions: host + `allowedMemberIds` can `play`, `pause`, `next`, `prev`,
  `skipTo(i)`, `promote(userId)` (host only). Everyone else sees controls disabled
  with a lock tooltip ("Only the host can change songs").
- Control action = read `musicState`, compute the new record, `store.put`.
  - `play(trackId)`: `currentTrackId = trackId`, `startedAt = Date.now()`,
    `positionMs = 0`, `playing = true`. (Default queue = library order; panel can
    reorder queue — allowed members too.)
  - `pause()`: `positionMs = positionMs + (Date.now() − startedAt)`,
    `startedAt = null`, `playing = false`.
  - `next()`: move to next in queue, reset timing.
- Every client's `MusicPanel` mirrors `musicState` into an `<audio>` element:
  - On `currentTrackId` change: `src = /media/track/:id`, and (if the browser has
    ever had a user gesture) `currentTime = positionMs/1000 + (playing ? (Date.now()−startedAt)/1000 : 0)`; `play()` if `playing`.
  - On `playing` change: seek + play/pause.
- **Autoplay policy (important):** browsers block audio without a gesture. Before
  the first user gesture, the panel shows a "Join playback" button (also lets a
  late joiner re-sync). After any click in the panel, audio may start freely.
- The spinning disc is pure CSS: `animation: spin 20s linear infinite`, paused
  (`animation-play-state`) when `!playing`; art = `background-image` from `artUrl`
  or a vinyl placeholder SVG.

### 10.3 Streaming
- `/media/track/:id` resolves the track's stored absolute path (id → `rel_path` →
  path under MUSIC_DIR; guard against `..`), streams via express static (Range
  support built-in → seekable, `Cache-Control: no-cache`).
- Node streams in this config are fine (single user set); no CDN needed.

---

## 11. UI/UX & design system (Phases 7–8)

### 11.1 Design tokens (from the tldraw-design skill — obey exactly)
Load `/home/2kfi/.claude/skills/tldraw-design/SKILL.md` and the related skills
before writing any UI:
- `ui-ux-pro-max`, `frontend-design` (Anthropic), `gsap-core`/`gsap-react`,
  `excalidraw-design` (only if a landing page is added later).
- Tokens (dark theme, no exceptions):
  - Background `#2e2e2e`; surface `#444444`; border `#1c1c1c`; text `#ffffff`;
    muted `#888d91`; accent/selection `#3182ed`; success `#099268`;
    warning `#f1ac4b`; danger `#e16919`.
  - Typography: **Inter** only (copy the `.ttf` files from
    `/home/2kfi/.claude/skills/tldraw-design/fonts/` into `src/web/assets/fonts/`
    and declare `@font-face`; body 14px/400, caption 13px, H1 28px/700, H2 21px/700,
    H3 16px/700; line-height 1.5 body / 1.2 headings; never another font family).
  - Spacing: strict 4 px grid (2,4,6,8,10,12,14,16,20,24,32); radius 10 px default.
  - No backdrop-blur anywhere. No invented colors, z-indexes, or radii.
  - Shadows: subtle (`inset 0 0 0 1px #1c1c1c`) for flat, `0 2px 12px #00000024`
    for floating elements.
  - Motion: 150–300 ms micro-interactions, 300–500 ms panel transitions, ease-out
    for enters. Always `@media (prefers-reduced-motion: reduce)` → kill all
    animation/transition durations.
- The tldraw editor itself keeps its own internal theme (its default UI is already
  on-theme); overlay the app chrome (home, panels, top bar) with these tokens.

### 11.2 Panels (the two custom surfaces)

**AI panel — left edge, toggle icon = mind SVG** (inline SVG, 20 px, hand-drawn
mind/head-with-gears motif; no icon library).
- Desktop: fixed-width 340 px panel docked left, slides in via GSAP
  (`x: -100% → 0`, 300 ms, ease-out; respect reduced-motion → no transform).
- Content: header ("Room AI" + model picker), chat list (scrollable), input row
  (textarea + send), lock banner when `lockedBy` is someone else.
- "Thinking" state: subtle pulse on the mind icon in the header.

**Music panel — right edge, toggle icon = disc SVG** (inline SVG: a vinyl record
with a center label).
- Desktop: fixed-width 340 px panel docked right.
- Content: header ("Room music" + refresh button), the spinning disc + title/artist
  + play/pause/next/prev, queue list (reorder by allowed members), permission
  tooltips.

**Top bar (inside the editor, right side):** room name (click to rename if host),
copy-link button, "Your boards" link, user name/color menu, mind + disc toggles.
Use tldraw's `TldrawUi` extension points (`components` prop) to slot these in
without fighting the editor layout — confirm the cleanest slot in Phase 1; the
safest is a custom overlay layer rendered above the editor with pointer-events
handled carefully (panels must not block canvas drag).

### 11.3 Responsive rules (Phase 8)
- Desktop (≥768 px, any orientation): side panels; both may be open at once
  (canvas keeps full size; panels overlay its edges).
- Mobile / portrait / small (≤767 px **or** `aspect-ratio < 1.2`): a panel opens as
  a **full-screen overlay over the canvas**; opening one **closes the other**
  (mutual exclusion). Backdrop with close on tap. Toggle icons stay visible in the
  top bar.
- Implement `useMediaQuery` hooks; single source of truth for "isCompact".

---

## 12. Docker & deployment (Phase 2+)

`Dockerfile` (multi-stage):
1. `node:22-alpine` builder: `npm ci`, `npm run build` (vite → `dist/web`,
   tsup → `dist/server`), `npm ci --omit=dev`.
2. Runtime: `node:22-alpine`, copy `dist/`, copy prod `node_modules`; `CMD ["node", "dist/server/index.js"]`.

`docker-compose.yml`:
```yaml
services:
  app:
    build: .
    ports: ["3000:3000"]
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - OPENAI_BASE_URL=${OPENAI_BASE_URL:-https://api.openai.com/v1}
      - OPENAI_DEFAULT_MODEL=${OPENAI_DEFAULT_MODEL:-gpt-4o-mini}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - GOOGLE_API_KEY=${GOOGLE_API_KEY:-}
      - SESSION_SECRET=${SESSION_SECRET:-dev-secret-change-me}
    volumes:
      - ./data:/data
      - ./music:/data/music:ro
    restart: unless-stopped
```
- `DATA_DIR=/data` in env; server writes sqlite + assets + art cache there.
- Reverse proxy note in README: put nginx/caddy in front for TLS; `wss` works
  through standard proxy upgrade config. Not part of the repo.

---

## 13. Build order — phases (each ends with a runnable check)

### Phase 1 — Scaffold + risk spike
- `package.json` with all deps (section 3), `tsconfig`, `vite`, `tsup`,
  `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md` skeleton.
- Vite app renders `<Tldraw />` (local, no sync yet) with the design tokens CSS.
- **Spike A (AI, from section 9.6):** scaffold the Agent Starter Kit
  (`npm create tldraw@latest -- --template agent`) and verify the headless port:
  (a) agent works on tldraw 5.3.2 in the browser (sanity); (b) headless `Editor`
  in Node over a synced store runs all agent ops without a DOM; (c) headless
  bounds/geometry for geo, text, note, arrow, draw (or adopt the props-based
  fallback); (d) kit `worker/prompt` + `AgentService` ported to an express route,
  streaming via `@ai-sdk/openai` with `OPENAI_BASE_URL`; (e) decision recorded in
  README: headless server agent GO / fallback chosen. This de-risks Phase 5.
- **Spike B (sync):** `TLSocketRoom` + `SQLiteSyncStorage` with the shared schema;
  two server-side sync clients exchange a record.
- Done: `docker compose up` renders the editor; spikes A/B are documented.
- **Gate: Phase 2 does not start until Spike A is documented as working or a
  fallback is chosen (section 9.6).**

### Phase 2 — Real-time rooms
- `sync.ts` full wiring (7.1), `useSync` client (7.2), anonymous identity (5.3),
  `POST /api/rooms`, `/r/:roomId` route.
- Done: two browsers on the same room see cursors, names, and live edits.

### Phase 3 — Persistence, host keys, "Your boards"
- `rooms` table, host key creation + hash, `claim`, HMAC host tokens,
  `GET/PUT /api/rooms`, `POST /api/rooms/mine`, Home "Your boards" list, rename,
  copy-link, **export/import JSON** (client-side: `editor.getSnapshot()` →
  JSON file download; import → `store.loadSnapshot()`).
- Done: restart the container → board intact; reclaim host on a second browser
  with the host key; export/import roundtrip restores shapes.

### Phase 4 — Assets & lazy loading
- `/api/assets` + `/media/asset/*` (8), client `TLAssetStore`.
- Done: paste/drop an image in one browser → appears (streaming in) in the other;
  reload is instant (cache headers); a 206 partial-content response exists.

### Phase 5 — Shared AI (Agent Starter Kit, headless)
- Vendor kit `shared/agent` (schemas, prompts, formats, lints, modelDefs); port
  `worker/prompt` + `AgentService` to express (`prompt.ts`, `service.ts`); port
  the agent loop to Node (`agent-loop.ts`, `sessions.ts`, `lock.ts`); headless
  Editor over the synced store; `aiContext.ts` (selection + viewport payload);
  `AIPanel` (9.5) with model picker (9.4); env config.
- Done: two users — user A runs a prompt, user B sees the lock banner + live text
  + action cards and cannot submit; the AI's shape edits appear on both canvases;
  model picker switches providers/models; **asker closes their tab mid-run → the
  AI finishes anyway**; error path (bad key) shows a friendly message and unlocks.

### Phase 6 — Music
- Scanner, `music_tracks`, art cache, `/media/track/*`, `/api/music` + refresh,
  `musicState` controls, `MusicPanel` (10).
- Done: drop 3 songs into `./music` → they appear; disc spins with art; play/pause/
  next from host syncs to a second browser within ~1 s; seek works; promoted guest
  can control; late joiner uses "Join playback".

### Phase 7 — Comments, follow mode, presence polish
- Verify comment tool + follow menu exist in the 3.15.4 default UI; enable them;
  if the default UI hides them, wire the built-in `TLCommentShape`/comment plugin
  and the presence "follow" buttons.
- Done: two browsers — comment thread works and syncs; clicking a user's name
  follows their view; unfollow works.

### Phase 8 — Responsive + design polish
- Apply tokens fully (11.1), panel chrome (11.2), responsive + mutual exclusion
  (11.3), GSAP transitions, mind/disc icons, reduced-motion.
- Done: phone-width viewport → panels full-screen and mutually exclusive; desktop
  → side panels; all motion respects `prefers-reduced-motion`; every color/space/
  radius traces to a token.

### Phase 9 — Hardening & verification
- Watchdog for stale AI locks; AI timeout; upload size/type guards; constant-time
  host-key compare; `zod` validation on all REST bodies; error page for dead rooms;
  offline indicator; README finalized.
- Run the full verification checklist (section 14) and fix anything red.

---

## 14. Verification checklist (final gate)

1. Two browsers, one room: cursors + names visible; edits sync < 500 ms; no
   conflicts/corruption after 50 rapid shape moves.
2. Container restart: board, music queue, and chat history intact.
3. Host flow: create → copy link → second browser joins as guest → claim host with
   key → rename works; wrong key → 401.
4. "Your boards" shows renamed rooms; export JSON → new room → import → identical
   shapes.
5. AI: edits appear on both canvases; lock banner + disabled input during run;
   model picker switches provider/models; error path (bad key) shows a friendly
   message and unlocks.
6. Music: 3 sample files (mp3 + m4a, one with embedded art, one with cover.jpg) →
   art correct; play/pause/next syncs; seek works (206); guest without permission
   sees disabled controls.
7. Mobile viewport: panels full-screen, opening AI closes music and vice versa;
   toggle icons render (mind/disc); canvas remains usable.
8. `prefers-reduced-motion: reduce` → no panel slides, no disc spin.
9. `npm ls tldraw @tldraw/sync @tldraw/sync-core` → one single 5.x version;
   `docker compose up` on a clean machine works from README instructions only.
10. Security sanity: no API keys in client bundle (`rg -i "sk-|openai" dist/web`
    shows nothing except configured names); `data/` not served by the static
    handler; no path traversal on `/media/*` (`/media/track/..%2f..%2fetc/passwd`
    → 400).

---

## 15. Risks & open items (track in README)

- **Headless geometry (Phase 1 spike):** bounds/geometry may need DOM text
  measurement for text/draw shapes; fallback = `shared/agent/bounds.ts`
  (props-based: x/y/w/h; draw = min/max over points). Slightly less exact, same
  formats.
- **Dropped screenshot part:** the headless server agent cannot capture the
  canvas; the model relies on structured shape data (Blurry/Focused/Peripheral).
  Upgrade path: a client-attached screenshot image part (the asker's browser
  captures once and attaches to the prompt) — additive, deferred.
- **Kit port surface:** the starter kit's `client/agent` is browser-tuned; we
  port, don't fork-and-forget — re-check upstream changes on each tldraw bump.
- **`SQLiteSyncStorage` adapter shape:** confirm the exact sql-interface expected
  by `@tldraw/sync-core` from its source during Phase 2; better-sqlite3 should
  match the synchronous variant.
- **Mobile autoplay:** browsers may block audio until a gesture; solved with the
  "Join playback" button (10.2). Test on iOS Safari specifically.
- **Music sync drift:** accepted; document that pause/next re-syncs. If users
  complain, a periodic (5 s) gentle re-seek can be added later.
- **Anonymous model:** no abuse protection; link-secret rooms only.
