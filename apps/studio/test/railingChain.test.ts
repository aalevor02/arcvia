/**
 * A railing survives the whole journey, not just each leg of it.
 *
 * The trained classifier marks a wall segment `kind: 'railing'`, and the studio
 * builds a railing at parapet height. Both ends were tested and both passed —
 * and the feature did not work, because `convertDetections` built its segments
 * without copying `kind`. Every wall arrived at the editor undefined, the
 * railing type was never applied, and every unit test still went green.
 *
 * So this test asserts the JOIN. It walks a detector result all the way to the
 * mesh and checks a parapet is 1.0 m while the partition beside it is not,
 * because that is the only claim a client can see.
 */
import * as THREE from 'three'

import { buildFloorGeometry } from '../src/plan/buildGeometry'
import { convertDetections } from '../src/plan/detections'
import type { DetectionResult, Underlay } from '../src/plan/detections'
import { addWall, activeFloor, emptyPlan } from '../src/plan/planStore'
import { WALL_DEFAULTS, wallTypeById } from '../src/plan/types'

let passed = 0
let failed = 0
const check = (label: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log(`PASS  ${label}`) }
  else { failed++; console.log(`FAIL  ${label}  ${detail}`) }
}

const underlay = {
  origin: { x: 0, y: 0 },
  width: 1000,
  height: 1000,
  scale: 0.01,
} as unknown as Underlay

/** One long line, unpaired, as a balcony edge is drawn. */
const line = (
  x1: number, y1: number, x2: number, y2: number,
  kind?: 'wall' | 'railing' | 'boundary',
) => ({
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  thickness: 0.004,
  confidence: 0.9,
  ...(kind ? { kind } : {}),
})

const result = {
  backend: 'heuristic',
  width: 1000,
  height: 1000,
  walls: [
    line(0.1, 0.1, 0.9, 0.1, 'railing'),
    line(0.1, 0.5, 0.9, 0.5),
  ],
  objects: [],
  rooms: [],
  scale: null,
  notes: [],
} as unknown as DetectionResult

// -- the leg that was broken --------------------------------------------------
const proposed = convertDetections(result, underlay, { minLength: 0.1 })
check('conversion produces both walls', proposed.length === 2, String(proposed.length))
const railing = proposed.find((w) => w.kind === 'railing')
const plain = proposed.find((w) => w.kind !== 'railing')
check('the railing verdict SURVIVES conversion', railing !== undefined,
  JSON.stringify(proposed.map((w) => w.kind)))
check('and the ordinary wall is not relabelled', plain !== undefined)

// -- and all the way to geometry, which is what a client sees -----------------
if (railing && plain) {
  const build = wallTypeById('railing')!
  let plan = emptyPlan()
  plan = addWall(plan, railing.a, railing.b, {
    thickness: build.thickness,
    height: build.height,
    type: build.id,
    snapRadius: 0.15,
  })
  plan = addWall(plan, plain.a, plain.b, {
    thickness: plain.thickness,
    height: WALL_DEFAULTS.interior.height,
    snapRadius: 0.15,
  })

  const floor = activeFloor(plan)
  const built = buildFloorGeometry(floor, { skirting: false })
  const heights = built.children
    .filter((c) => c.name.startsWith('wall:'))
    .map((c) => {
      const mesh = c as THREE.Mesh
      mesh.geometry.computeBoundingBox()
      const box = mesh.geometry.boundingBox!
      return box.max.y - box.min.y
    })
    .sort((a, b) => a - b)

  check('two walls are built', heights.length === 2, JSON.stringify(heights))
  check('the parapet reaches guard height, not the ceiling',
    Math.abs(heights[0] - 1.0) < 0.01, String(heights[0]))
  check('the partition beside it stays full height',
    Math.abs(heights[1] - WALL_DEFAULTS.interior.height) < 0.01, String(heights[1]))
  check('so a client can see the difference',
    heights[1] - heights[0] > 1.5, `${heights[1]} vs ${heights[0]}`)
}

// -- an unmarked reader (older service) must behave exactly as before ---------
{
  const older = { ...result, walls: [line(0.1, 0.1, 0.9, 0.1)] } as unknown as DetectionResult
  const out = convertDetections(older, underlay, { minLength: 0.1 })
  check('a reader that sends no kind yields no kind, rather than a default',
    out[0]?.kind === undefined, String(out[0]?.kind))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
