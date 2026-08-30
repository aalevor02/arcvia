import { describeViewerFailure } from '../src/plan/viewerFailure'

/**
 * What a failed 3D view tells the user.
 *
 * The studio had NO error boundary anywhere, so a throw inside `SceneView`
 * unmounted the whole React tree and left a blank page — no plan, no room list,
 * no tools, no message. Everything was still saved and nothing on screen said
 * so. Observed on the owner's machine while testing an upload:
 *
 *     THREE.WebGLRenderer: A WebGL context could not be created.
 *       Reason: Web page caused context loss and was blocked
 *
 * The boundary itself is React plumbing. What is worth testing is the judgement
 * it makes: which failures are worth retrying, and whether the user is told the
 * thing that actually matters — that their work is safe.
 */

let passed = 0
let failed = 0
const check = (label: string, condition: boolean, extra = '') => {
  if (condition) {
    passed++
    console.log(`PASS  ${label}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

// ---- the exact error the owner hit -------------------------------------------
{
  const blocked = describeViewerFailure(
    new Error('Error creating WebGL context. Web page caused context loss and was blocked'),
  )

  check('a blocked context is named as a memory problem',
    /graphics memory/i.test(blocked.title), blocked.title)
  check('and does NOT offer a retry that cannot work', blocked.canRetry === false)
  check('and says the plan is safe, which is the only thing the user needs',
    /saved/i.test(blocked.detail), blocked.detail)
  check('and says the 2D editor still works, so they know where to go',
    /2D editor/i.test(blocked.detail))
}

// ---- a plain context loss, which does clear -----------------------------------
// Chrome takes the context back under pressure and usually returns it. That one
// IS worth retrying, and the difference matters: a "Try again" button that can
// never work is worse than no button.
{
  const lost = describeViewerFailure(new Error('THREE.WebGLRenderer: Context Lost.'))
  check('a plain context loss offers a retry', lost.canRetry === true)
  check('and is not described as running out of memory',
    !/ran out/i.test(lost.title), lost.title)
}

// ---- anything else -------------------------------------------------------------
// The boundary catches every throw below it, not only WebGL ones. An unknown
// failure must still say the plan is safe, and must quote the error rather than
// hiding it — a swallowed error nobody can see is how a reproducible fault
// becomes a rumour.
{
  const other = describeViewerFailure(new TypeError('cannot read properties of null'))
  check('an unrelated error still reassures about the plan', /saved/i.test(other.detail))
  check('and quotes what actually went wrong',
    other.detail.includes('cannot read properties of null'), other.detail)
  check('and offers a retry, since nothing says it cannot work', other.canRetry === true)
}

// ---- things thrown that are not Errors ------------------------------------------
// React hands the boundary whatever was thrown. A string, undefined and an
// object all reach it, and none may produce "undefined" in the message.
{
  for (const thrown of ['boom', undefined, null, { code: 42 }]) {
    const described = describeViewerFailure(thrown)
    check(`a thrown ${JSON.stringify(thrown) ?? 'undefined'} still produces a message`,
      described.title.length > 0 && described.detail.length > 0
        && !/undefined|\[object/.test(described.title),
      described.detail)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
