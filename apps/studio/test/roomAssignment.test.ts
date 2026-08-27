import { assignDesigns, assignOne, unresolved } from '../src/plan/roomAssignment'

let passed = 0
let failed = 0
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`PASS  ${label}`) }
  else { failed++; console.log(`FAIL  ${label}  ${detail}`) }
}

const ROOMS = ['bedroom', 'master-bedroom', 'living-room', 'kitchen', 'bathroom']

// -- the bug this module exists for -----------------------------------------
// roomTokens splits on non-alphanumerics, so 'master-bedroom' is
// ['master','bedroom'] and a caption of "Bedroom" is a subset of it. The old
// matcher painted BOTH rooms. Specificity has to break the tie by itself,
// because asking about a case this common would train people to click through.
{
  const a = assignOne('Bedroom', ROOMS)
  check('an exact caption beats a subset match on a longer room name',
    a.status === 'auto' && a.room === 'bedroom', `${a.status}/${a.room}`)
  check('and it is reported at full confidence', a.confidence === 1, String(a.confidence))
}

{
  const a = assignOne('Master Bedroom', ROOMS)
  check('the longer caption still resolves to its own room',
    a.status === 'auto' && a.room === 'master-bedroom', `${a.status}/${a.room}`)
}

// -- genuine ambiguity is a question, not a coin toss ------------------------
{
  const a = assignOne('Bed', ['bed-1-room', 'bed-2-room'])
  check('a caption fitting two rooms paints neither', a.status === 'confirm' && a.room === null,
    `${a.status}/${a.room}`)
  check('and it names both so the question is answerable',
    a.candidates.length === 2 && a.reason.includes('bed-1-room') && a.reason.includes('bed-2-room'),
    a.reason)
}

{
  const a = assignOne('Bedroom', ['bedroom', 'bedroom'])
  check('two rooms with the identical name are a question, not a first-wins',
    a.status === 'confirm' && a.room === null, `${a.status}/${a.room}`)
}

// -- nothing to match on -----------------------------------------------------
{
  const blank = assignOne('   ', ROOMS)
  check('an uncaptioned render is unmatched, not silently dropped',
    blank.status === 'unmatched' && blank.reason.includes('no room caption'), blank.reason)

  const absent = assignOne('Wine Cellar', ROOMS)
  check('a room this plan does not have is unmatched and says so',
    absent.status === 'unmatched' && absent.reason.includes('Wine Cellar'), absent.reason)
}

// -- two renders claiming one room ------------------------------------------
// Invisible to a per-caption pass: each is individually unambiguous. Only
// comparing them reveals that the later one would silently overwrite the first.
{
  const out = assignDesigns(['Kitchen', 'kitchen'], ROOMS)
  check('two renders resolving to one room both stop', 
    out.every((a) => a.status === 'confirm' && a.room === null),
    out.map((a) => `${a.status}/${a.room}`).join(' '))
  check('and each names the other rather than just "conflict"',
    out[0].reason.includes('"kitchen"') && out[1].reason.includes('"Kitchen"'),
    out.map((a) => a.reason).join(' | '))
}

// -- the ordinary multi-room deck still runs untouched ------------------------
{
  const out = assignDesigns(['Bedroom', 'Living Room', 'Kitchen'], ROOMS)
  check('a clean deck needs no confirmation at all',
    unresolved(out).length === 0, JSON.stringify(out.map((a) => a.status)))
  check('and each render went to its own room',
    new Set(out.map((a) => a.room)).size === 3, JSON.stringify(out.map((a) => a.room)))
}

// -- caption noise ------------------------------------------------------------
{
  const a = assignOne('Master Bedroom Interior Render', ROOMS)
  check('deck caption noise ("interior", "render") does not defeat the match',
    a.status === 'auto' && a.room === 'master-bedroom', `${a.status}/${a.room}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
