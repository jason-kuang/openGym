// Reference solution (scratch — held out, never committed).
import { EXIDX } from './exercises.js'
import { matchExercise } from './import-csv.js'

const HEADER = ['Date', 'Workout Name', 'Duration', 'Exercise Name', 'Set Order', 'Weight', 'Reps', 'Distance', 'Seconds', 'Notes', 'Workout Notes', 'RPE']

const q = v => {
  const s = String(v ?? '')
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

// Raw word tokens (no synonym/filler knowledge needed — matchExercise verifies).
const tokensOf = name => String(name || '').toLowerCase().replace(/[()[\]]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)

function* subsets(arr) {
  const u = [...new Set(arr)], n = u.length
  for (let size = n; size >= 1; size--) {
    const idx = Array.from({ length: size }, (_, i) => i)
    for (;;) {
      yield idx.map(i => u[i])
      let i = size - 1
      for (; i >= 0 && idx[i] === n - size + i; i--);
      if (i < 0) break
      idx[i]++
      for (let j = i + 1; j < size; j++) idx[j] = idx[j - 1] + 1
    }
  }
}

// A name that resolves back to id, verified through the app's own resolver.
export function resolvingName(id) {
  const e = EXIDX[id]
  if (!e) return null
  if (matchExercise(e.n) === id) return e.n
  for (const sub of subsets(tokensOf(e.n))) {
    const c = sub.join(' ')
    if (matchExercise(c) === id) return c
  }
  return e.n
}

function cardioCells(min, speed) {
  let secs = min * 60
  if (Math.abs(secs - Math.round(secs)) < 1e-9) secs = Math.round(secs)
  const mins2 = Math.round(secs / 60 * 10) / 10
  const H = mins2 / 60
  let km = speed * H
  for (let i = 0; i < 10000; i++) {
    const back = Math.round(km / H * 10) / 10
    if (back === speed && mins2 === min) break
    km += (km || 1) * 1e-7
  }
  return { km: String(km), secs: String(secs) }
}

const p2 = n => String(n).padStart(2, '0')
function fmtStart(start, d) {
  if (start == null) return d
  const t = new Date(start)
  return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`
}

export function exportStrongCSV(S) {
  const customs = new Map((S.customEx || []).map(c => [c.id, c.n]))
  const lines = [HEADER.join(',')]
  for (const w of S.workouts || []) {
    const date = fmtStart(w.start, w.d)
    const wname = w.name || ''
    let order = 0
    for (const e of w.entries || []) {
      let exName
      if (customs.has(e.id)) {
        const cn = customs.get(e.id)
        exName = matchExercise(cn) == null ? cn : cn + ' (Custom)'
      } else if (EXIDX[e.id]) {
        exName = resolvingName(e.id)
      } else {
        exName = e.id
      }
      let n = 0
      for (const s of e.sets || []) {
        n++
        let row
        if (s.min != null || s.speed != null) {
          const { km, secs } = cardioCells(s.min || 0, s.speed || 0)
          row = [date, wname, '', exName, n, '', '', km, secs, '', '', '']
        } else if (s.sec != null) {
          row = [date, wname, '', exName, n, s.w ?? '', '', '', '', '', '', '']
        } else {
          const rpe = s.rir != null ? '' : s.rpe != null ? String(s.rpe) : ''
          row = [date, wname, '', exName, n, s.w ?? '', s.r ?? '', '', '', '', '', rpe]
        }
        lines.push(row.map(q).join(','))
      }
      order++
    }
  }
  return lines.join('\n') + '\n'
}
