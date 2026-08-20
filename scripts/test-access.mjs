import WebSocket from 'ws'

const PORT = process.env.PORT ?? 3199
const BASE = `http://127.0.0.1:${PORT}`
const HDRS = { 'x-user-id': 'u1', 'x-user-name': 'Alice', 'x-user-color': '#3182ed' }

async function j(path, init = {}, expect = 200) {
  const res = await fetch(BASE + path, init)
  const text = await res.text()
  const body = text ? JSON.parse(text) : null
  if (res.status !== expect) throw new Error(`${path}: expected ${expect}, got ${res.status} ${text}`)
  return body
}

let failures = 0
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`)
  if (!cond) failures++
}

// --- public room (bodiless POST, as the spikes do) ---
const pub = await j('/api/rooms', { method: 'POST' })
check('public create returns roomId+hostKey', !!pub.roomId && !!pub.hostKey)
const pubInfo = await j(`/api/rooms/${pub.roomId}`)
check('public info: no password, no approval', pubInfo.requiresPassword === false && pubInfo.requireApproval === false)
check('public info: hash never returned', !('password_hash' in pubInfo))

// --- private + approval room ---
const priv = await j('/api/rooms', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: 's3cret', requireApproval: true }),
})
const privInfo = await j(`/api/rooms/${priv.roomId}`)
check('private info flags', privInfo.requiresPassword === true && privInfo.requireApproval === true)
check('private info: hash never returned', !('password_hash' in privInfo))

// --- wrong password ---
try {
  await j(`/api/rooms/${priv.roomId}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...HDRS }, body: JSON.stringify({ password: 'nope' }) }, 401)
  check('wrong password -> 401', true)
} catch (e) {
  check('wrong password -> 401: ' + e.message, false)
}

// --- correct password, approval required -> pending ---
const pendRes = await j(`/api/rooms/${priv.roomId}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...HDRS }, body: JSON.stringify({ password: 's3cret' }) })
check('join -> pending (no token)', pendRes.status === 'pending' && !pendRes.token)

// --- pending list needs host token ---
try {
  await j(`/api/rooms/${priv.roomId}/pending`, {}, 401)
  check('pending without host token -> 401', true)
} catch (e) {
  check('pending without host token -> 401: ' + e.message, false)
}

// --- claim host ---
const claim = await j(`/api/rooms/${priv.roomId}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...HDRS }, body: JSON.stringify({ hostKey: priv.hostKey }) })
const hostToken = claim.hostToken

const pendingList = await j(`/api/rooms/${priv.roomId}/pending`, { headers: { 'x-host-token': hostToken } })
check('pending list shows Alice', pendingList.length === 1 && pendingList[0].userName === 'Alice')

const st1 = await j(`/api/rooms/${priv.roomId}/join/status`, { headers: HDRS })
check('status pending before approve', st1.status === 'pending' && !st1.token)

await j(`/api/rooms/${priv.roomId}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-host-token': hostToken }, body: JSON.stringify({ userId: 'u1' }) })

const st2 = await j(`/api/rooms/${priv.roomId}/join/status`, { headers: HDRS })
check('status approved with token', st2.status === 'approved' && !!st2.token)

const st3 = await j(`/api/rooms/${priv.roomId}/join/status`, { headers: HDRS })
check('status idempotent (approved stays)', st3.status === 'approved' && !!st3.token)
const joinToken = st3.token

// --- re-join after approval returns ok immediately ---
const rejoin = await j(`/api/rooms/${priv.roomId}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...HDRS }, body: JSON.stringify({ password: 's3cret' }) })
check('re-join after approval -> ok+token', rejoin.status === 'ok' && !!rejoin.token)

// --- WS gate ---
function wsConnect(roomId, cookie) {
  return new Promise((resolve) => {
    let opened = false
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/sync/${roomId}`, { headers: cookie ? { Cookie: `t2join=${encodeURIComponent(cookie)}` } : {} })
    ws.on('open', () => { opened = true })
    ws.on('close', (code) => resolve(opened ? `closed-after-open:${code}` : `closed:${code}`))
    ws.on('error', (e) => resolve('error:' + e.message))
    setTimeout(() => resolve(opened ? 'open' : 'timeout'), 800)
  })
}
function rejects(name, result, expected = '1008') {
  check(name, result.includes(expected))
}
const u1b = { 'x-user-id': 'u1', 'x-user-name': 'Alice', 'x-user-color': '#3182ed' }
const pubCookie = (await j(`/api/rooms/${pub.roomId}/join`, { method: 'POST', headers: { ...u1b } })).token
check('public room WS without token -> open', (await wsConnect(pub.roomId)) === 'open')
check('public room WS with token -> open', (await wsConnect(pub.roomId, pubCookie)) === 'open')
rejects('private room WS without token -> 1008', await wsConnect(priv.roomId))
check('private room WS with join token -> open', (await wsConnect(priv.roomId, joinToken)) === 'open')
rejects('private room WS with token for OTHER room -> 1008', await wsConnect(priv.roomId, pubCookie))
rejects('private room WS with garbage token -> 1008', await wsConnect(priv.roomId, 'garbage'))

// --- PUT: rename + clear password + disable approval ---
const upd = await j(`/api/rooms/${priv.roomId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-host-token': hostToken }, body: JSON.stringify({ name: 'New name', password: '', requireApproval: false }) })
check('PUT updates name', upd.name === 'New name')
check('PUT clears password', upd.requiresPassword === false)
check('PUT disables approval', upd.requireApproval === false)
const pub2 = await j(`/api/rooms/${priv.roomId}/join/status`, { headers: u1b })
check('after clearing password, join/status is ok', pub2.status === 'ok' && !!pub2.token)

// --- PUT with no fields (just touch) ---
const touch = await j(`/api/rooms/${priv.roomId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-host-token': hostToken }, body: JSON.stringify({}) })
check('PUT empty body ok', touch.name === 'New name')

// --- setting a password via PUT then WS gate rejects ---
await j(`/api/rooms/${priv.roomId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-host-token': hostToken }, body: JSON.stringify({ password: 'newpass' }) })
rejects('private again after PUT set password', await wsConnect(priv.roomId))
const join2 = await j(`/api/rooms/${priv.roomId}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...u1b }, body: JSON.stringify({ password: 'newpass' }) })
check('join with new password (approval off) -> ok', join2.status === 'ok' && !!join2.token)
check('WS with new token -> open', (await wsConnect(priv.roomId, join2.token)) === 'open')

// --- invalid bodies still 400 ---
try { await j(`/api/rooms/${priv.roomId}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-host-token': hostToken }, body: JSON.stringify({}) }, 400); check('approve empty body 400', true) } catch (e) { check('approve empty body 400: ' + e.message, false) }
try { await j('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requireApproval: 'yes' }) }, 400); check('create bad requireApproval 400', true) } catch (e) { check('create bad requireApproval 400: ' + e.message, false) }

// --- unknown room 404 ---
try { await j('/api/rooms/zzzzzzzzzz', {}, 404); check('unknown room 404', true) } catch (e) { check('unknown room 404: ' + e.message, false) }

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)