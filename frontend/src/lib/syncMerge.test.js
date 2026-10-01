import { describe, it, expect, vi } from 'vitest'
import {
  mergeStates,
  trackLocalChanges,
  stripForUpload,
  pushWithRetry,
  sameContent,
} from './syncMerge.js'

const W = (id, extra = {}) => ({ id, d: '2026-09-20', start: 1, end: 2, ...extra })
const R = (id, extra = {}) => ({ id, name: id, emoji: '🏋️', ex: [], ...extra })
const BW = (d, w, t) => ({ d, w, t })

// Every merge decision must be order-independent so both sync orders converge.
const expectSymmetric = (a, b) => {
  expect(mergeStates(b, a)).toEqual(mergeStates(a, b))
}

const base = () => ({
  workouts: [],
  routines: [],
  customEx: [],
  bodyweight: [],
  exWeights: {},
  week: {},
  dayPlan: {},
  active: null,
  _ts: 1000,
  _sync: { tomb: [], touch: {} },
})

describe('union of additions', () => {
  it('workouts, routines and bodyweight from either side all survive', () => {
    const a = { ...base(), workouts: [W('w1')], bodyweight: [BW('2026-09-20', 80, 10)] }
    const b = { ...base(), routines: [R('r1')], bodyweight: [BW('2026-09-21', 81, 20)] }
    const m = mergeStates(a, b)
    expect(m.workouts.map(w => w.id)).toEqual(['w1'])
    expect(m.routines.map(r => r.id)).toEqual(['r1'])
    expect(m.bodyweight.map(x => x.d).sort()).toEqual(['2026-09-20', '2026-09-21'])
    expectSymmetric(a, b)
  })
})

describe('delete semantics', () => {
  it('delete wins when the other side never touched the entry', () => {
    const v = W('w1', { updatedAt: 100 })
    const a = { ...base(), workouts: [v], _sync: { tomb: [], touch: {} } }
    const b = { ...base(), workouts: [], _sync: { tomb: [{ k: 'w:w1', t: 200 }], touch: {} } }
    expect(mergeStates(a, b).workouts).toEqual([])
    expect(mergeStates(b, a).workouts).toEqual([])
  })

  it('edit wins over delete when edited after the delete', () => {
    const edited = W('w1', { updatedAt: 300, note: 'edited' })
    const a = { ...base(), workouts: [edited] }
    const b = { ...base(), workouts: [], _sync: { tomb: [{ k: 'w:w1', t: 200 }], touch: {} } }
    for (const m of [mergeStates(a, b), mergeStates(b, a)]) {
      expect(m.workouts).toHaveLength(1)
      expect(m.workouts[0].note).toBe('edited')
      // Edit absorbed the delete: the tombstone retires.
      expect(m._sync.tomb.map(t => t.k)).not.toContain('w:w1')
    }
  })

  it('trackLocalChanges records a tombstone when update() removes an id', () => {
    const before = { ...base(), workouts: [W('w1', { updatedAt: 50 })] }
    const after = JSON.parse(JSON.stringify(before))
    after.workouts = []
    trackLocalChanges(before, after, 999)
    expect(after._sync.tomb).toContainEqual({ k: 'w:w1', t: 999 })
  })

  it('trackLocalChanges stamps changed and new entities', () => {
    const before = { ...base(), routines: [R('r1', { updatedAt: 50 })] }
    const after = JSON.parse(JSON.stringify(before))
    after.routines[0].name = 'renamed'
    after.routines.push(R('r2'))
    trackLocalChanges(before, after, 999)
    expect(after.routines.find(r => r.id === 'r1').updatedAt).toBe(999)
    expect(after.routines.find(r => r.id === 'r2').updatedAt).toBe(999)
  })
})

describe('same-id double edit', () => {
  it('later timestamp wins and both orders agree', () => {
    const a = { ...base(), workouts: [W('w1', { updatedAt: 100, name: 'old' })] }
    const b = { ...base(), workouts: [W('w1', { updatedAt: 200, name: 'new' })] }
    for (const m of [mergeStates(a, b), mergeStates(b, a)]) {
      expect(m.workouts).toHaveLength(1)
      expect(m.workouts[0].name).toBe('new')
    }
  })

  it('timestamp tie compares versions directly and converges', () => {
    const a = { ...base(), routines: [R('r1', { updatedAt: 100, name: 'beta' })] }
    const b = { ...base(), routines: [R('r1', { updatedAt: 100, name: 'alpha' })] }
    const m1 = mergeStates(a, b)
    expect(mergeStates(b, a)).toEqual(m1)
    expect(m1.routines).toHaveLength(1)
    expect(m1.routines[0].name).toBe('alpha')
  })
})

describe('bodyweight days', () => {
  it('same day keeps the later-logged entry, exactly one row', () => {
    const a = { ...base(), bodyweight: [BW('2026-09-20', 80, 1000)] }
    const b = { ...base(), bodyweight: [BW('2026-09-20', 81, 2000)] }
    for (const m of [mergeStates(a, b), mergeStates(b, a)]) {
      expect(m.bodyweight).toHaveLength(1)
      expect(m.bodyweight[0].w).toBe(81)
    }
  })

  it('deleted day stays deleted unless relogged later', () => {
    const a = { ...base(), bodyweight: [BW('2026-09-20', 80, 1000)] }
    const gone = { ...base(), _sync: { tomb: [{ k: 'bw:2026-09-20', t: 1500 }], touch: {} } }
    expect(mergeStates(a, gone).bodyweight).toEqual([])
    const relogged = { ...base(), bodyweight: [BW('2026-09-20', 82, 2500)] }
    expect(mergeStates(relogged, gone).bodyweight[0].w).toBe(82)
  })
})

describe('per-key maps', () => {
  it('week merges per weekday by touch order', () => {
    const a = {
      ...base(),
      week: { Mon: 'r1', Wed: 'r2' },
      _sync: { tomb: [], touch: { 'week:Mon': 100 } },
    }
    const b = {
      ...base(),
      week: { Wed: 'r3', Fri: 'r4' },
      _sync: { tomb: [], touch: { 'week:Wed': 200, 'week:Fri': 200 } },
    }
    const m = mergeStates(a, b)
    // Mon only on A, Fri only on B, Wed contested and B touched it later.
    expect(m.week).toEqual({ Mon: 'r1', Wed: 'r3', Fri: 'r4' })
    expectSymmetric(a, b)
  })

  it('dayPlan override delete wins over untouched, loses to later edit', () => {
    const a = { ...base(), dayPlan: {}, _sync: { tomb: [{ k: 'dp:2026-09-22', t: 300 }], touch: {} } }
    const b = { ...base(), dayPlan: { '2026-09-22': 'r9' }, _sync: { tomb: [], touch: { 'dp:2026-09-22': 100 } } }
    expect(mergeStates(a, b).dayPlan).toEqual({})
    const edited = { ...base(), dayPlan: { '2026-09-22': 'r9' }, _sync: { tomb: [], touch: { 'dp:2026-09-22': 400 } } }
    expect(mergeStates(a, edited).dayPlan).toEqual({ '2026-09-22': 'r9' })
  })

  it('exWeights merge per exercise, later PR date wins', () => {
    const a = { ...base(), exWeights: { bench: { w: 60, d: '2026-09-18' } } }
    const b = { ...base(), exWeights: { bench: { w: 62.5, d: '2026-09-20' }, squat: { w: 80, d: '2026-09-20' } } }
    const m = mergeStates(a, b)
    expect(m.exWeights.bench).toEqual({ w: 62.5, d: '2026-09-20' })
    expect(m.exWeights.squat).toEqual({ w: 80, d: '2026-09-20' })
    expectSymmetric(a, b)
  })
})

describe('active is device-local', () => {
  it('merge never takes, uploads, or clears the in-progress workout', () => {
    const active = { id: 'live', d: '2026-09-20', start: 5 }
    const a = { ...base(), active, workouts: [W('w1')] }
    const b = { ...base(), active: null, workouts: [W('w2')] }
    const m = mergeStates(a, b)
    expect(m.active).toEqual(active)
    expect(mergeStates(b, a).active).toBeNull()
    expect(stripForUpload(m)).not.toHaveProperty('active')
    expect(stripForUpload(m)).not.toHaveProperty('_rev')
  })
})

describe('two-device interleave', () => {
  it('both sync orders converge to identical state', () => {
    const seed = {
      ...base(),
      workouts: [W('w0', { updatedAt: 10 })],
      routines: [R('r0', { updatedAt: 10 })],
      week: { Mon: 'r0' },
    }
    // Device A: new workout + Monday replan. Device B: new routine + bodyweight.
    const A = JSON.parse(JSON.stringify(seed))
    A.workouts.push({ ...W('wA'), updatedAt: 100 })
    A.week.Mon = 'rA'
    A.routines.push({ ...R('rA'), updatedAt: 100 })
    A._sync = { tomb: [], touch: { 'week:Mon': 100 } }
    const B = JSON.parse(JSON.stringify(seed))
    B.routines.push({ ...R('rB'), updatedAt: 150 })
    B.bodyweight.push(BW('2026-09-21', 79, 150))
    B._sync = { tomb: [], touch: {} }

    // Order 1: A uploads, B merges then uploads.
    const afterA = mergeStates(A, seed)
    const order1 = mergeStates(mergeStates(B, afterA), afterA)
    // Order 2: B uploads, A merges then uploads.
    const afterB = mergeStates(B, seed)
    const order2 = mergeStates(mergeStates(A, afterB), afterB)
    expect(order1).toEqual(order2)
    expect(order1.workouts.map(w => w.id).sort()).toEqual(['w0', 'wA'])
    expect(order1.routines.map(r => r.id).sort()).toEqual(['r0', 'rA', 'rB'])
    expect(order1.bodyweight).toHaveLength(1)
    expect(order1.week.Mon).toBe('rA')
  })
})

describe('pushWithRetry', () => {
  it('uploads once when the revision is fresh', async () => {
    const put = vi.fn(async () => ({ rev: 7 }))
    const local = { ...base(), workouts: [W('w1')] }
    const res = await pushWithRetry({ local, baseRev: 6, put, merge: mergeStates })
    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0][0].baseRev).toBe(6)
    expect(res.rev).toBe(7)
    expect(res.state.workouts).toEqual(local.workouts)
  })

  it('on 409 merges the server state and retries with the new revision', async () => {
    const serverState = { ...base(), workouts: [W('srv')], _ts: 50 }
    const put = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('stale'), { status: 409, data: { state: serverState, rev: 9 } }))
      .mockResolvedValueOnce({ rev: 10 })
    const local = { ...base(), workouts: [W('mine')], _ts: 60 }
    const res = await pushWithRetry({ local, baseRev: 8, put, merge: mergeStates })
    expect(put).toHaveBeenCalledTimes(2)
    expect(put.mock.calls[1][0].baseRev).toBe(9)
    const ids = res.state.workouts.map(w => w.id).sort()
    expect(ids).toEqual(['mine', 'srv'])
    expect(res.rev).toBe(10)
  })

  it('gives up and throws after repeated stale rejections', async () => {
    const serverState = { ...base() }
    const put = vi.fn(async () => {
      throw Object.assign(new Error('stale'), { status: 409, data: { state: serverState, rev: 9 } })
    })
    await expect(pushWithRetry({ local: base(), baseRev: 8, put, merge: mergeStates, maxAttempts: 2 })).rejects.toThrow(
      'stale'
    )
    expect(put).toHaveBeenCalledTimes(2)
  })

  it('does not retry non-409 failures', async () => {
    const put = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { status: 500 })
    })
    await expect(pushWithRetry({ local: base(), baseRev: 8, put, merge: mergeStates })).rejects.toThrow('boom')
    expect(put).toHaveBeenCalledTimes(1)
  })
})

describe('sameContent', () => {
  it('ignores _ts but nothing else', () => {
    expect(sameContent({ ...base(), _ts: 1 }, { ...base(), _ts: 2 })).toBe(true)
    expect(sameContent(base(), { ...base(), workouts: [W('x')] })).toBe(false)
  })
})
