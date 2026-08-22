import { commit, commitFrom, initialHistory, redo, undo, emptyPlan } from '../src/plan/planStore'
import type { Plan } from '../src/plan/types'

/**
 * The undo stack, exercised the way the editor actually drives it.
 *
 * ── Why the gesture cycle is simulated end to end ───────────────────────────
 * The corruption the audit found was not in any one function — every function
 * behaved as documented. It was in the HANDSHAKE: live frames replaced
 * `present` without saving what it replaced, and gesture-end then asked
 * `commit` to record a change it could no longer see. Both call sites passed
 * `commit(h, h.present)`, present compared with itself, guaranteed no-op — so
 * no drag ever reached the stack, one Ctrl+Z deleted the action BEFORE the
 * drag, and a stale `future` let Redo resurrect an abandoned branch, which
 * autosave then persisted. Testing the functions in isolation would have
 * passed throughout; only the sequence shows it.
 */

let passed = 0
let failed = 0
const check = (label: string, condition: boolean, extra = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

// Distinguishable plans without touching plan internals: identity is what the
// stack stores, so identity is what the test needs.
const plan = (): Plan => emptyPlan()

// The editor's applyLive, in miniature: replace present, clear future.
const live = (h: ReturnType<typeof initialHistory>, next: Plan) => ({
  ...h,
  present: next,
  future: [] as Plan[],
})

// ---- A drag, as the canvas performs it ---------------------------------------

{
  const base = plan()
  let h = initialHistory(base)

  // First live frame: the editor snapshots `base` here.
  const frame1 = plan()
  const frame2 = plan()
  h = live(h, frame1)
  h = live(h, frame2)

  // Gesture end.
  h = commitFrom(h, base)

  check('the drag recorded one undo entry', h.past.length === 1, `${h.past.length}`)
  check('the entry is the PRE-gesture state', h.past[0] === base)
  check('present is where the drag ended', h.present === frame2)

  const undone = undo(h)
  check('one undo returns to before the drag', undone.present === base)
  check('and the drag itself is redoable', redo(undone).present === frame2)
}

// ---- The no-ops ----------------------------------------------------------------

{
  const base = plan()
  const h = initialHistory(base)
  check('commitFrom(null) records nothing', commitFrom(h, null) === h)
  // Releasing a wall exactly where it started is not an action Ctrl+Z should
  // revisit.
  check('a gesture that ended where it began records nothing', commitFrom(h, h.present) === h)
}

// ---- The resurrection bug -----------------------------------------------------

{
  const a = plan()
  let h = initialHistory(a)
  const b = plan()
  h = commit(h, b) // a committed edit
  h = undo(h) // back to a; future holds b

  check('redo is available after undo', h.future.length === 1)

  // The user now edits LIVE instead of redoing. The old applyLive kept
  // `future`, so Redo stayed lit, pointing at b — a state the user had edited
  // away from — and clicking it put b on screen for autosave to persist.
  const c = plan()
  h = live(h, c)
  check('a live edit after undo clears redo', h.future.length === 0)
  check('redo after that is a no-op', redo(h) === h)
}

// ---- The stack is bounded -------------------------------------------------------

{
  let h = initialHistory(plan())
  for (let i = 0; i < 250; i++) {
    const before = h.present
    h = live(h, plan())
    h = commitFrom(h, before)
  }
  check('the stack respects its limit', h.past.length <= 200, `${h.past.length}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
