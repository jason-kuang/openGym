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
const DIR = mkdtempSync(join(tmpdir(), 'gym-sync-proto-'))

// Import-hook entry point for the spawned API server. Redirects the server's
// push-notification and passkey modules to local stubs so the data sync paths
// (/api/data) boot and run with zero third-party dependencies.
// Written to the temp dir at runtime (see beforeAll).
const REGISTER_MJS = `import { register } from 'node:module';

register('./syncServerHooks.mjs', import.meta.url);
`

// Resolve hook: server-only heavy deps resolve to hermetic stubs. The sync
// protocol test exercises /api/data, which never touches passkeys or push.
const HOOKS_MJS = `import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STUBS = {
  '@simplewebauthn/server': 'syncServerStubs.mjs',
  'web-push': 'syncServerStubs.mjs',
};

export async function resolve(specifier, context, nextResolve) {
  const file = STUBS[specifier];
  if (file) {
    const url = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), file)
    ).href;
    return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`

// Hermetic stand-ins for the API server's push/passkey modules, used only by
// the sync protocol test. /api/data never calls these; any accidental call
// throws loudly instead of silently succeeding.
const STUBS_MJS = `const unreachable = name => () => {
  throw new Error(\`syncServerStubs: \${name} must not run in protocol tests\`);
};

export const generateRegistrationOptions = unreachable('generateRegistrationOptions');
export const verifyRegistrationResponse = unreachable('verifyRegistrationResponse');
export const generateAuthenticationOptions = unreachable('generateAuthenticationOptions');
export const verifyAuthenticationResponse = unreachable('verifyAuthenticationResponse');

const webpush = {
  generateVAPIDKeys: () => ({ publicKey: 'stub-public', privateKey: 'stub-private' }),
  setVapidDetails: () => {},
  sendNotification: unreachable('sendNotification'),
};

export default webpush;
`
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
    // Server-only push/passkey modules resolve to hermetic stubs written
    // into the temp dir above: /api/data never touches them, and this keeps
    // the test independent of third-party API dependencies.
    writeFileSync(join(DIR, 'syncServerRegister.mjs'), REGISTER_MJS)
    writeFileSync(join(DIR, 'syncServerHooks.mjs'), HOOKS_MJS)
    writeFileSync(join(DIR, 'syncServerStubs.mjs'), STUBS_MJS)
    child = spawn(
      process.execPath,
      ['--import', join(DIR, 'syncServerRegister.mjs'), join(ROOT, 'api', 'server.js')],
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
