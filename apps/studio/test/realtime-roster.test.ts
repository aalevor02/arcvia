import { reduceRoster, type Peer } from '../src/lib/realtime-roster'

/**
 * The presence roster: who else is in the scene, after each server message.
 *
 * The socket half needs a browser and is covered by the server's own relay
 * test; this pins the pure reducer — the part that silently rots when a message
 * type is added and nobody updates the "who's here" strip.
 */

let passed = 0
let failed = 0
function check(label: string, cond: boolean, detail = '') {
  if (cond) {
    passed++
    console.log(`PASS  ${label}${detail ? '  ' + detail : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${detail ? '  ' + detail : ''}`)
  }
}

const bob: Peer = { userId: 'bob', name: 'bob', colour: '#e8590c' }
const cara: Peer = { userId: 'cara', name: 'cara', colour: '#2f9e44' }

// welcome replaces the roster with the server's list (already self-excluded).
check('welcome sets the roster from the server',
  reduceRoster([], { type: 'welcome', you: { userId: 'me', name: 'me', colour: '#fff' }, peers: [bob] })
    .length === 1)

// joined appends.
{
  const after = reduceRoster([bob], { type: 'joined', peer: cara })
  check('joined adds the new peer', after.length === 2 && after.some((p) => p.userId === 'cara'))
}

// joined is idempotent — a duplicate (a resent join, a race) does not double.
check('joined ignores someone already present',
  reduceRoster([bob], { type: 'joined', peer: bob }).length === 1)

// left removes exactly that person.
{
  const after = reduceRoster([bob, cara], { type: 'left', userId: 'bob' })
  check('left removes only the departing peer',
    after.length === 1 && after[0].userId === 'cara')
}

// left for someone not present is a no-op, not a throw.
check('left for an unknown user is a no-op',
  reduceRoster([bob], { type: 'left', userId: 'nobody' }).length === 1)

// plan and cursor do not touch the roster — they are content, not presence.
check('a plan message leaves the roster unchanged',
  reduceRoster([bob], { type: 'plan', from: 'bob', plan: {} }).length === 1)
check('a cursor message leaves the roster unchanged',
  reduceRoster([bob], { type: 'cursor', from: 'bob', x: 1, y: 2 }).length === 1)

// The reducer never mutates its input.
{
  const input: Peer[] = [bob]
  reduceRoster(input, { type: 'joined', peer: cara })
  check('the reducer does not mutate its input', input.length === 1)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
