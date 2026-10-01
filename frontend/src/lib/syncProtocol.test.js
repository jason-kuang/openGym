// Sync revision protocol against the real API server: stale uploads are
// refused with the current state (409) instead of overwriting, fresh uploads
// bump the revision, and device-local fields never persist.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = mkdtempSync(join(tmpdir(), 'gym-sync-proto-'))
const PORT = 38271 + (process.pid % 1000)
const BASE = `http://127.0.0.1:${PORT}`

let child

const mintCookie = uid => {
  const secret = readFileSync(join(DIR, 'secret'), 'utf8').trim()
  const payload = `${uid}:${Date.now() + 86400000}:0`
  const mac = createHmac('sha256', secret).update(payload).digest('base64url')
  return `gymsid=${payload}.${mac}`
}

const req = (path, { method = 'GET', body, cookie } = {}) =>
  fetch(BASE + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))

describe('sync revision protocol', () => {
  beforeAll(async () => {
    writeFileSync(
      join(DIR, 'db.json'),
      JSON.stringify({ users: [{ id: 'u1' }, { id: 'u2' }], creds: [], subs: [], invites: [] })
    )
    // Server-only push/passkey modules resolve to hermetic stubs (see
    // syncServerRegister.mjs): /api/data never touches them, and this keeps
    // the test independent of third-party API dependencies.
    child = spawn(
      process.execPath,
      ['--import', join(HERE, 'syncServerRegister.mjs'), join(ROOT, 'api', 'server.js')],
      {
        env: { ...process.env, PORT: String(PORT), DATA_DIR: DIR },
        stdio: 'ignore',
      }
    )
    for (let i = 0; i < 100; i++) {
      try {
        // Any HTTP answer (even 401 without a cookie) proves the port is up.
        const r = await req('/api/data')
        if (r.status === 401 || r.status === 200) return
      } catch {}
      await new Promise(r => setTimeout(r, 100))
    }
    throw new Error('server did not start')
  }, 30000)

  afterAll(() => {
    child?.kill()
  })

  it('fresh account starts null at rev 0, first upload bumps to 1', async () => {
    const cookie = mintCookie('u1')
    const get = await req('/api/data', { cookie })
    expect(get.json).toEqual({ state: null, rev: 0 })
    const put = await req('/api/data', {
      method: 'PUT',
      cookie,
      body: { state: { workouts: [{ id: 'w1' }], active: { id: 'live' }, _rev: 99, _ts: 5 }, baseRev: 0 },
    })
    expect(put.status).toBe(200)
    expect(put.json.rev).toBe(1)
    const stored = JSON.parse(readFileSync(join(DIR, 'state-u1.json'), 'utf8'))
    expect(stored.workouts).toEqual([{ id: 'w1' }])
    expect(stored).not.toHaveProperty('active')
    expect(stored).not.toHaveProperty('_rev')
  })

  it('stale upload is refused with current state and changes nothing', async () => {
    const cookie = mintCookie('u1')
    const before = readFileSync(join(DIR, 'state-u1.json'), 'utf8')
    const stale = await req('/api/data', {
      method: 'PUT',
      cookie,
      body: { state: { workouts: [{ id: 'evil' }] }, baseRev: 0 },
    })
    expect(stale.status).toBe(409)
    expect(stale.json.rev).toBe(1)
    expect(stale.json.state.workouts).toEqual([{ id: 'w1' }])
    expect(readFileSync(join(DIR, 'state-u1.json'), 'utf8')).toBe(before)
  })

  it('fresh upload writes and bumps the revision', async () => {
    const cookie = mintCookie('u1')
    const put = await req('/api/data', {
      method: 'PUT',
      cookie,
      body: { state: { workouts: [{ id: 'w1' }, { id: 'w2' }] }, baseRev: 1 },
    })
    expect(put.status).toBe(200)
    expect(put.json.rev).toBe(2)
    const get = await req('/api/data', { cookie })
    expect(get.json.rev).toBe(2)
    expect(get.json.state.workouts.map(w => w.id)).toEqual(['w1', 'w2'])
  })

  it('upload without baseRev fails closed once synced', async () => {
    const cookie = mintCookie('u1')
    const put = await req('/api/data', {
      method: 'PUT',
      cookie,
      body: { state: { workouts: [] } },
    })
    expect(put.status).toBe(409)
  })

  // Preserved behavior: passes on base and with the change (P2P).
  it('unauthenticated data access is rejected', async () => {
    expect((await req('/api/data')).status).toBe(401)
    expect((await req('/api/data', { method: 'PUT', body: { state: {} } })).status).toBe(401)
  })

  it('upload without a state object is rejected', async () => {
    const cookie = mintCookie('u2')
    const put = await req('/api/data', { method: 'PUT', cookie, body: { baseRev: 0 } })
    expect(put.status).toBe(400)
  })

  it('in-progress workout is stripped from stored state', async () => {
    const cookie = mintCookie('u2')
    const put = await req('/api/data', {
      method: 'PUT',
      cookie,
      body: { state: { workouts: [], active: { id: 'live' } }, baseRev: 0 },
    })
    expect(put.status).toBe(200)
    const get = await req('/api/data', { cookie })
    expect(get.json.state).not.toHaveProperty('active')
  })

  it('sequential uploads persist each state', async () => {
    const cookie = mintCookie('u2')
    const put = await req('/api/data', {
      method: 'PUT',
      cookie,
      body: { state: { workouts: [{ id: 'w9' }] }, baseRev: 1 },
    })
    expect(put.status).toBe(200)
    const get = await req('/api/data', { cookie })
    expect(get.json.state.workouts.map(w => w.id)).toEqual(['w9'])
  })
})
