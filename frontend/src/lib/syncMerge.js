// Merge-based two-device sync for openGym state.
//
// Two snapshots (local + server) are combined without a base copy. Identity:
// workouts/routines/custom exercises by id, bodyweight by day, exWeights by
// exercise id, week/dayPlan by key. Every decision below is order-independent
// (merge(A, B) deep-equals merge(B, A)) so both sync orders converge, except
// `active`, which is device-local by design and always kept from the local side.
//
// Timestamps: entities carry updatedAt (stamped centrally by the store on
// every mutation); bodyweight uses its logged time t; exWeights uses its
// PR date d. Deletes are tombstones in S._sync.tomb; per-key touches for the
// timestamp-less week/dayPlan maps live in S._sync.touch. Tombstones older
// than TOMBSTONE_TTL_MS are pruned once neither side holds the entry.

export const TOMBSTONE_TTL_MS = 30 * 86400 * 1000

// Fields decided wholesale by newer S._ts (user preferences; never contend
// meaningfully and the instruction leaves them unspecified).
export const SCALAR_FIELDS = [
  'unit', 'restSec', 'sound', 'keepAwake', 'lang', 'theme', 'accent',
  'body', 'targetW', 'gifSize', 'reminder', 'effort',
]

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v)

export function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  if (isObj(v)) {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
  }
  return JSON.stringify(v) ?? 'null'
}

const sameValue = (a, b) => stableStringify(a) === stableStringify(b)

// Deterministic pick between two differing versions. Symmetric by
// construction: both devices choose the same one.
const pickVersion = (a, b) => (stableStringify(a) <= stableStringify(b) ? a : b)

const clone = o => JSON.parse(JSON.stringify(o))

function blankSync() {
  return { tomb: [], touch: {} }
}

function readSync(S) {
  const s = (S && S._sync) || {}
  return { tomb: Array.isArray(s.tomb) ? s.tomb : [], touch: isObj(s.touch) ? s.touch : {} }
}

function tombMap(tomb) {
  const m = new Map()
  for (const t of tomb) {
    if (!t || typeof t.k !== 'string') continue
    const prev = m.get(t.k)
    if (!prev || (t.t || 0) > (prev.t || 0)) m.set(t.k, t)
  }
  return m
}

// Entity edit timestamps by collection.
function entityTs(kind, e) {
  if (kind === 'bw') {
    if (e && e.t != null && Number.isFinite(+e.t)) return +e.t
    const d = Date.parse(e && e.d)
    return Number.isFinite(d) ? d : 0
  }
  if (kind === 'e') {
    // exWeights entries date their PR; fall back to epoch for legacy rows.
    const d = Date.parse(e && e.d)
    return Number.isFinite(d) ? d : 0
  }
  return (e && e.updatedAt) || 0
}

function entityKey(kind, e, fallback) {
  if (kind === 'bw') return 'bw:' + (e.d || fallback)
  return kind + ':' + (e.id || fallback)
}

// Merge one id-keyed collection (workouts, routines, customEx by id;
// bodyweight by day; exWeights by exercise id via keyOf).
function mergeCollection(kind, aList, bList, tombs, keyOf = null) {
  const key = keyOf || ((e, fb) => entityKey(kind, e, fb))
  const A = new Map()
  const B = new Map()
  ;(aList || []).forEach((e, i) => { if (e) A.set(key(e, 'a' + i), e) })
  ;(bList || []).forEach((e, i) => { if (e) B.set(key(e, 'b' + i), e) })
  const out = []
  // Deterministic order so both sync orders converge byte-identically. Ids
  // from uid() start with a base-36 timestamp, so id order is chronological.
  const order = [...new Set([...A.keys(), ...B.keys()])].sort()
  for (const k of order) {
    const a = A.get(k)
    const b = B.get(k)
    const tomb = tombs.get(k)
    const tombT = (tomb && tomb.t) || 0
    if (a !== undefined && b !== undefined) {
      if (sameValue(a, b)) {
        out.push(clone(a))
        continue
      }
      const ta = entityTs(kind, a)
      const tb = entityTs(kind, b)
      // A tombstone only deletes when it is strictly newer than the edit it
      // faces; ties keep the edit (never silently lose edited data).
      const winner = ta === tb ? pickVersion(a, b) : ta > tb ? a : b
      const winnerTs = ta === tb ? Math.max(ta, tb) : Math.max(ta, tb)
      if (tombT > winnerTs) continue
      out.push(clone(winner))
      continue
    }
    const present = a !== undefined ? a : b
    if (tombT > entityTs(kind, present)) continue
    out.push(clone(present))
  }
  return out
}

// Merge one scalar map (week keyed by weekday, dayPlan by date). Values carry
// no timestamps, so per-key touches recorded at mutation time order them.
function mergeKeyMap(aMap, bMap, prefix, touchA, touchB, tombs) {
  const A = aMap || {}
  const B = bMap || {}
  const out = {}
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    const tk = prefix + ':' + k
    const inA = A[k] !== undefined
    const inB = B[k] !== undefined
    const tA = touchA[tk] || 0
    const tB = touchB[tk] || 0
    const tomb = tombs.get(tk)
    const tombT = (tomb && tomb.t) || 0
    if (inA && inB) {
      if (sameValue(A[k], B[k])) {
        out[k] = clone(A[k])
        continue
      }
      const winner = tA === tB ? pickVersion(A[k], B[k]) : tA > tB ? A[k] : B[k]
      const winnerTs = Math.max(tA, tB)
      if (tombT > winnerTs) continue
      out[k] = clone(winner)
      continue
    }
    const present = inA ? A[k] : B[k]
    const presentT = inA ? tA : tB
    if (tombT > presentT) continue
    out[k] = clone(present)
  }
  return out
}

// Combine two states. localActive is preserved verbatim; everything else is
// decided symmetrically. Never mutates its inputs.
export function mergeStates(local, remote) {
  const A = local || {}
  const B = remote || {}
  const sA = readSync(A)
  const sB = readSync(B)
  const tombs = tombMap([...sA.tomb, ...sB.tomb])

  const out = {}
  out.workouts = mergeCollection('w', A.workouts, B.workouts, tombs)
  out.routines = mergeCollection('r', A.routines, B.routines, tombs)
  out.customEx = mergeCollection('c', A.customEx, B.customEx, tombs)
  out.bodyweight = mergeCollection('bw', A.bodyweight, B.bodyweight, tombs)
  out.exWeights = {}
  {
    const Aew = A.exWeights || {}
    const Bew = B.exWeights || {}
    const asList = m => Object.entries(m).map(([id, e]) => ({ ...(isObj(e) ? e : { w: e }), __k: id }))
    const merged = mergeCollection('e', asList(Aew), asList(Bew), tombs, e => 'e:' + e.__k)
    for (const e of merged) {
      const { __k, ...rest } = e
      // Keep the stored shape untouched when nothing extra was attached.
      out.exWeights[__k] = rest
    }
  }
  const touch = {}
  for (const k of new Set([...Object.keys(sA.touch), ...Object.keys(sB.touch)])) {
    touch[k] = Math.max(sA.touch[k] || 0, sB.touch[k] || 0)
  }
  out.week = mergeKeyMap(A.week, B.week, 'week', sA.touch, sB.touch, tombs)
  out.dayPlan = mergeKeyMap(A.dayPlan, B.dayPlan, 'dp', sA.touch, sB.touch, tombs)

  const tsA = A._ts || 0
  const tsB = B._ts || 0
  for (const f of SCALAR_FIELDS) {
    const a = A[f]
    const b = B[f]
    if (a === undefined && b === undefined) continue
    if (a === undefined) {
      out[f] = clone(b)
      continue
    }
    if (b === undefined) {
      out[f] = clone(a)
      continue
    }
    if (sameValue(a, b)) {
      out[f] = clone(a)
      continue
    }
    out[f] = clone(tsA === tsB ? pickVersion(a, b) : tsA > tsB ? a : b)
  }
  out._ts = Math.max(tsA, tsB)
  if (A._rev !== undefined) out._rev = A._rev

  // A tombstone retires once its id is held: the surviving copy carries a
  // timestamp at or above the tombstone's, so it wins any future comparison
  // on its own merits. Tombstones for absent ids are kept (a side that still
  // shows the entry must keep losing to them) and retire after the TTL.
  const now = Date.now()
  const held = new Set()
  const hold = (list, kind, getK) => (list || []).forEach(e => { if (e) held.add(kind + ':' + getK(e)) })
  hold(out.workouts, 'w', e => e.id)
  hold(out.routines, 'r', e => e.id)
  hold(out.customEx, 'c', e => e.id)
  hold(out.bodyweight, 'bw', e => e.d)
  Object.keys(out.exWeights || {}).forEach(id => held.add('e:' + id))
  Object.keys(out.week || {}).forEach(k => held.add('week:' + k))
  Object.keys(out.dayPlan || {}).forEach(k => held.add('dp:' + k))
  const tomb = []
  for (const [k, t] of tombs) {
    if (held.has(k)) continue
    if (now - (t.t || 0) < TOMBSTONE_TTL_MS) tomb.push({ k, t: t.t })
  }
  tomb.sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0))

  // Touches retire with the keys they describe.
  const liveTouch = {}
  for (const [k, ts] of Object.entries(touch)) {
    const [prefix, ...rest] = k.split(':')
    const key = rest.join(':')
    const alive =
      (prefix === 'week' && out.week && out.week[key] !== undefined) ||
      (prefix === 'dp' && out.dayPlan && out.dayPlan[key] !== undefined)
    if (alive) liveTouch[k] = ts
  }
  out._sync = { tomb, touch: liveTouch }

  // Device-local by design: never merged, never uploaded, never cleared.
  out.active = A.active === undefined ? null : A.active
  return out
}

// Record the mutations a local edit made: stamp changed/new entities,
// tombstone vanished ids/keys, touch changed scalar-map keys. Mutates draft.
export function trackLocalChanges(before, after, now = Date.now()) {
  const B = before || {}
  const S = after
  if (!S._sync || !isObj(S._sync)) S._sync = blankSync()
  else S._sync = { tomb: [...(S._sync.tomb || [])], touch: { ...(S._sync.touch || {}) } }

  const forget = k => {
    S._sync.tomb = S._sync.tomb.filter(t => t.k !== k)
  }
  const rememberDelete = k => {
    forget(k)
    S._sync.tomb.push({ k, t: now })
  }

  for (const [field, kind] of [['workouts', 'w'], ['routines', 'r'], ['customEx', 'c']]) {
    const bMap = new Map()
    ;(B[field] || []).forEach(e => { if (e && e.id !== undefined) bMap.set(kind + ':' + e.id, e) })
    const seen = new Set()
    for (const e of S[field] || []) {
      if (!e || e.id === undefined) continue
      const k = kind + ':' + e.id
      seen.add(k)
      const prev = bMap.get(k)
      if (!prev || !sameValue({ ...e, updatedAt: 0 }, { ...prev, updatedAt: 0 })) {
        e.updatedAt = now
      }
      forget(k)
    }
    for (const k of bMap.keys()) {
      if (!seen.has(k)) rememberDelete(k)
    }
  }

  {
    const bMap = new Map()
    ;(B.bodyweight || []).forEach(e => { if (e) bMap.set('bw:' + e.d, e) })
    const seen = new Set()
    for (const e of S.bodyweight || []) {
      if (!e) continue
      const k = 'bw:' + e.d
      seen.add(k)
      forget(k)
    }
    for (const k of bMap.keys()) {
      if (!seen.has(k)) rememberDelete(k)
    }
  }

  {
    const bMap = new Map()
    for (const [id, e] of Object.entries(B.exWeights || {})) bMap.set('e:' + id, e)
    const seen = new Set(Object.keys(S.exWeights || {}).map(id => 'e:' + id))
    for (const k of bMap.keys()) {
      if (!seen.has(k)) rememberDelete(k)
    }
    for (const k of [...seen]) forget(k)
  }

  for (const [field, prefix] of [['week', 'week'], ['dayPlan', 'dp']]) {
    const bMap = B[field] || {}
    const sMap = S[field] || {}
    for (const k of new Set([...Object.keys(bMap), ...Object.keys(sMap)])) {
      const tk = prefix + ':' + k
      const inB = bMap[k] !== undefined
      const inS = sMap[k] !== undefined
      if (inS && (!inB || !sameValue(bMap[k], sMap[k]))) {
        S._sync.touch[tk] = now
        forget(tk)
      } else if (!inS && inB) {
        rememberDelete(tk)
        delete S._sync.touch[tk]
      }
    }
  }
  return S
}

// Copy of a state safe to upload: drops device-local and client-only fields.
// The server strips active again on receipt; both ends enforce it.
export function stripForUpload(S) {
  const out = clone(S || {})
  delete out.active
  delete out._rev
  return out
}

// Upload with merge-and-retry. put({state, baseRev}) and merge(a, b) are
// injected so this is unit-testable without a server. Resolves {state, rev}
// on success; throws the last error after maxAttempts stale rejections or on
// any non-409 failure.
export async function pushWithRetry({ local, baseRev, put, merge, maxAttempts = 3 }) {
  let current = local
  let rev = baseRev
  let lastError = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await put({ state: stripForUpload(current), baseRev: rev })
      if (!res || typeof res.rev !== 'number') throw new Error('upload response missing revision')
      const done = clone(current)
      done._rev = res.rev
      return { state: done, rev: res.rev }
    } catch (e) {
      lastError = e
      const d = e && e.data
      if (!(e && e.status === 409) || !d || d.state == null || typeof d.rev !== 'number') break
      current = merge(current, d.state)
      rev = d.rev
    }
  }
  throw lastError
}

// Equality for "did the merge change anything" checks. _ts is excluded: the
// store re-stamps on every persist, so it always differs after a save.
export function sameContent(a, b) {
  const strip = s => {
    const o = { ...(s || {}) }
    delete o._ts
    return o
  }
  return sameValue(strip(a), strip(b))
}
