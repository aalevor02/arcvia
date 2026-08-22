/**
 * The render camera faces what it framed — orientation is axis-converted too.
 *
 * ── What was broken ─────────────────────────────────────────────────────────
 * render.js converted the camera POSITION from Three.js Y-up to Blender Z-up
 * (a +90° turn about X) but forwarded the ORIENTATION quaternion untouched. So
 * the camera stood in the right place and faced the wrong way — a view framing
 * the origin from (6,4,6) rendered ~66° off, a level walkthrough camera pointed
 * at the floor. Every AI and still render, and invisible because bake.mjs
 * asserted only the position.
 *
 * ── How this is verified without Blender ────────────────────────────────────
 * Pure geometry. Build the Three.js camera that a browser would send — at a
 * position, looking at a target, Y-up. Its world quaternion is what the studio
 * emits. Run it through `toBlenderQuat`, then compute the Blender camera's
 * forward (its local -Z rotated by that quaternion) and its position via
 * `toBlenderVec`. The forward MUST point from the converted position toward the
 * converted target — i.e. the camera in Z-up looks at the same world point it
 * framed in Y-up. That is the whole claim, and it is exact.
 *
 * Run: node test/camera-orientation.mjs
 */

import { toBlenderVec, toBlenderQuat } from '../src/routes/render.js'

let passed = 0
let failed = 0
const ok = (label, cond, extra = '') => {
  if (cond) {
    passed++
    console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`)
  }
}

// ---- Minimal vector / quaternion helpers ----------------------------------
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
const norm = (a) => {
  const l = Math.hypot(a.x, a.y, a.z) || 1
  return { x: a.x / l, y: a.y / l, z: a.z / l }
}
const rotate = (q, v) => {
  // v' = q · v · q*   (v as a pure quaternion)
  const p = { x: v.x, y: v.y, z: v.z, w: 0 }
  const qc = { x: -q.x, y: -q.y, z: -q.z, w: q.w }
  const mul = (a, b) => ({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  })
  const r = mul(mul(q, p), qc)
  return { x: r.x, y: r.y, z: r.z }
}

/**
 * The world quaternion of a Three.js PerspectiveCamera at `eye` looking at
 * `target` with world up `+Y`. Camera looks down its local -Z; local +Y is up,
 * local +X is right. This is exactly what Object3D.lookAt builds, expressed as
 * a quaternion from the resulting orthonormal basis.
 */
function lookAtQuaternion(eye, target) {
  const up = { x: 0, y: 1, z: 0 }
  const z = norm(sub(eye, target)) // camera looks down -Z, so +Z points back toward the eye
  const x = norm(cross(up, z))
  const y = cross(z, x)
  // Basis (x, y, z) as columns -> quaternion (standard matrix-to-quat).
  const m00 = x.x, m01 = y.x, m02 = z.x
  const m10 = x.y, m11 = y.y, m12 = z.y
  const m20 = x.z, m21 = y.z, m22 = z.z
  const trace = m00 + m11 + m22
  let qx, qy, qz, qw
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    qw = 0.25 / s
    qx = (m21 - m12) * s
    qy = (m02 - m20) * s
    qz = (m10 - m01) * s
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    qw = (m21 - m12) / s
    qx = 0.25 * s
    qy = (m01 + m10) / s
    qz = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    qw = (m02 - m20) / s
    qx = (m01 + m10) / s
    qy = 0.25 * s
    qz = (m12 + m21) / s
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
    qw = (m10 - m01) / s
    qx = (m02 + m20) / s
    qy = (m12 + m21) / s
    qz = 0.25 * s
  }
  return { x: qx, y: qy, z: qz, w: qw }
}

/** Angle in degrees between two vectors. */
const angleDeg = (a, b) =>
  (Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) * 180) / Math.PI

// ---- The case the audit measured: (6,4,6) framing the origin --------------
{
  const eye = { x: 6, y: 4, z: 6 }
  const target = { x: 0, y: 0, z: 0 }

  const qThree = lookAtQuaternion(eye, target)
  const qBlender = toBlenderQuat(qThree)

  // Blender camera also looks down its local -Z.
  const forward = rotate(qBlender, { x: 0, y: 0, z: -1 })
  const wantForward = sub(toBlenderVec(target), toBlenderVec(eye))

  const off = angleDeg(forward, wantForward)
  ok('the converted camera looks straight at what it framed', off < 0.01,
     `${off.toFixed(4)}° off`)

  // The bug rendered this exact view ~66° off; assert the UNCONVERTED path is
  // wrong, so the test proves the conversion is doing the work.
  const forwardRaw = rotate(qThree, { x: 0, y: 0, z: -1 })
  const offRaw = angleDeg(forwardRaw, wantForward)
  ok('and the old un-converted quaternion was badly off', offRaw > 30,
     `${offRaw.toFixed(1)}° off — the bug`)
}

// ---- A level walkthrough camera must not point at the floor ---------------
{
  const eye = { x: 0, y: 1.6, z: 0 }
  const target = { x: 0, y: 1.6, z: -5 } // looking level, down -Z
  const qBlender = toBlenderQuat(lookAtQuaternion(eye, target))
  const forward = rotate(qBlender, { x: 0, y: 0, z: -1 })
  const wantForward = sub(toBlenderVec(target), toBlenderVec(eye))
  ok('a level camera stays level after conversion', angleDeg(forward, wantForward) < 0.01,
     `${angleDeg(forward, wantForward).toFixed(4)}° off`)
  // Its Blender forward should be horizontal (near-zero Z component in Z-up).
  ok('and its view is horizontal, not aimed at the floor',
     Math.abs(norm(forward).z) < 0.01, `z=${norm(forward).z.toFixed(4)}`)
}

// ---- A few random poses: conversion is exact for every one ----------------
{
  const eyes = [
    [{ x: 3, y: 2, z: 8 }, { x: 1, y: 0.5, z: 0 }],
    [{ x: -5, y: 6, z: -2 }, { x: 0, y: 1, z: 0 }],
    [{ x: 10, y: 1.5, z: -4 }, { x: 2, y: 1.5, z: 3 }],
  ]
  let worst = 0
  for (const [eye, target] of eyes) {
    const qBlender = toBlenderQuat(lookAtQuaternion(eye, target))
    const forward = rotate(qBlender, { x: 0, y: 0, z: -1 })
    const want = sub(toBlenderVec(target), toBlenderVec(eye))
    worst = Math.max(worst, angleDeg(forward, want))
  }
  ok('every sampled pose converts exactly', worst < 0.01, `worst ${worst.toFixed(4)}°`)
}

// ---- null is null ----------------------------------------------------------
ok('a null rotation stays null', toBlenderQuat(null) === null)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
