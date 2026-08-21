import * as THREE from 'three'
import { SceneViewer } from '@arcvia/viewer'
import type { VillaType } from '../types'
import { h } from '../ui/dom'

/**
 * The villa as an animated architectural model.
 *
 * This replaced a first-person walkthrough, and the reason matters. The geometry
 * is derived from 2D floor plans: it is accurate as *massing* — floor plates,
 * envelope, columns, openings — but the upper levels have few enclosing walls,
 * because the drawings show open terraces and pool decks rather than rooms. Free
 * roaming put the visitor outside the building within two steps, surrounded by
 * disconnected wall stubs, which reads as broken rather than as unfinished.
 *
 * Seen from outside, the same geometry reads well. So the presentation plays to
 * that: a slow orbit, floors that lift apart on demand, eased moves between
 * them. Deliberately stylised — it is honest about being a model, and a model
 * that looks intentional beats a walkthrough that looks broken.
 */

const GAP = 4.2          // metres a floor lifts in the exploded view
const ORBIT_SPEED = 0.055 // radians per second, slow enough to read as ambient
const EASE = 3.2          // approach rate; higher settles faster

type Floor = { object: any; base: number; height: number; label: string; id: string }

let active: { viewer: SceneViewer; stop: () => void } | null = null

export function disposeLive(): void {
  active?.stop()
  active?.viewer.dispose()
  active = null
}

function pretty(id: string): string {
  return id.replace(/^floor_/, '').replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

export function liveScene(type: VillaType): HTMLElement {
  const scene = type.walkthrough!
  const canvas = h('canvas')
  const stage = h('div', { class: 'walk' }, canvas)

  const status = h('p', { class: 'weight' }, 'A 3D model of the villa · loads on demand')
  const controls = h('div', { class: 'walk-views', style: 'display:none' })

  const enter = h('button', { class: 'btn', type: 'button' }, 'Explore the 3D model')

  // The film, when there is one, IS the cover: it plays behind the gate rather
  // than sitting next to a still. A rendered orbit sells the villa in a way the
  // real-time model cannot, so it leads.
  const film = scene.film
    ? h('video', {
        class: 'walk-film',
        src: scene.film,
        autoplay: '',
        loop: '',
        muted: '',
        playsinline: '',
        preload: 'metadata',
      })
    : null
  if (film) (film as HTMLVideoElement).muted = true

  const cover = h(
    'div',
    {
      class: 'walk-cover',
      style: film ? '' : `background-image:url(renders/${type.renders[0]}.webp)`,
    },
    ...(film ? [film] : []),
    h(
      'div',
      { class: 'walk-gate' },
      h('h2', {}, type.name),
      h('p', {}, 'Drag to turn the model, pick a level to lift the floors apart.'),
      status,
      h('p', { style: 'margin-top:22px' }, enter),
    ),
  )
  enter.addEventListener('click', () => void start())
  stage.appendChild(cover)

  async function start(): Promise<void> {
    enter.setAttribute('disabled', 'true')
    status.textContent = 'Loading…'

    const viewer = new SceneViewer({
      canvas,
      onProgress: (f) => {
        status.textContent = `Loading… ${Math.round(f * 100)}%`
      },
      onError: (e) => {
        status.textContent = e.message
        enter.removeAttribute('disabled')
      },
      onReady: () => {
        cover.remove()
        controls.style.display = ''
      },
    })

    if (scene.environment) await viewer.loadEnvironment(scene.environment)
    await viewer.loadModel(scene.model)
    viewer.setOrbitEnabled(true)   // the visitor keeps the camera

    const root = viewer.modelRoot
    if (!root) return

    // Height comes from the geometry, not from position.y: each floor object is
    // exported with its vertices already at world coordinates, so every one of
    // them sits at y = 0 and sorting on position would order them arbitrarily.
    const lowestVertex = (o: any): number => {
      let min = Infinity
      o.traverse((m: any) => {
        if (!m.isMesh || !m.geometry) return
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
        const bb = m.geometry.boundingBox
        if (bb && bb.min.y < min) min = bb.min.y
      })
      return Number.isFinite(min) ? min : 0
    }

    const floors: Floor[] = []
    let sky: any = null
    root.traverse((child: any) => {
      if (typeof child.name !== 'string') return
      if (child.name === 'Sky') sky = child
      if (child.name.startsWith('floor_')) {
        floors.push({
          object: child,
          base: child.position.y,
          height: lowestVertex(child),
          label: pretty(child.name),
          id: child.name,
        })
      }
    })
    // bottom level first, so lifting reads as the building opening upward
    floors.sort((a, b) => a.height - b.height)

    let selected = -1              // -1 = whole villa, closed
    let spinning = true
    let raf = 0
    let last = performance.now()

    if (sky) sky.visible = true

    // Spin the MODEL, not the camera.
    //
    // SceneViewer says it plainly: "Orbit and walk cannot both own the camera;
    // whichever is enabled last would fight the other every frame." Driving the
    // camera here while OrbitControls was enabled produced a black canvas -
    // the controls reset the camera after every frame this loop positioned it.
    // Rotating the model sidesteps the conflict entirely and leaves drag-to-turn
    // working, which is what a visitor expects of a model anyway.
    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    let minZ = Infinity, maxZ = -Infinity
    for (const f of floors) {
      f.object.traverse((m: any) => {
        if (!m.isMesh || !m.geometry) return
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
        const bb = m.geometry.boundingBox
        if (!bb) return
        minX = Math.min(minX, bb.min.x); maxX = Math.max(maxX, bb.max.x)
        minY = Math.min(minY, bb.min.y); maxY = Math.max(maxY, bb.max.y)
        minZ = Math.min(minZ, bb.min.z); maxZ = Math.max(maxZ, bb.max.z)
      })
    }
    const cx = Number.isFinite(minX) ? (minX + maxX) / 2 : 0
    const cz = Number.isFinite(minZ) ? (minZ + maxZ) / 2 : 0
    void minY; void maxY

    // A pivot at the villa's centre, so it turns on the spot instead of swinging
    // around the world origin - the floors carry world coordinates, so their own
    // origins are all (0,0,0) and rotating them directly orbits the building
    // around a point outside itself.
    const pivot = new THREE.Group()
    pivot.position.set(cx, 0, cz)
    root.add(pivot)
    for (const f of floors) {
      pivot.add(f.object)
      f.object.position.x -= cx
      f.object.position.z -= cz
      f.base = f.object.position.y
    }
    // Frame the VILLA, not the sky. The dome is a 90 m sphere, so leaving it in
    // the scene while framing fits the camera to a 180 m ball and the building
    // becomes a speck inside it - which is exactly the blue sphere the first
    // attempt rendered. Detach it, frame, put it back.
    const skyParent = sky ? sky.parent : null
    if (sky && skyParent) skyParent.remove(sky)
    viewer.frameModel()
    if (sky && skyParent) skyParent.add(sky)

    const targets = new Map<string, number>()
    const setTargets = (): void => {
      floors.forEach((f, i) => {
        const lift = selected < 0 ? 0 : (i > selected ? GAP * (i - selected) : 0)
        targets.set(f.id, f.base + lift)
      })
    }
    setTargets()

    function frame(now: number): void {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      let moving = false

      for (const f of floors) {
        const want = targets.get(f.id) ?? f.base
        const y = f.object.position.y
        if (Math.abs(y - want) > 0.002) {
          f.object.position.y = y + (want - y) * Math.min(1, EASE * dt)
          moving = true
        } else if (y !== want) {
          f.object.position.y = want
          moving = true
        }
        if (selected >= 0) {
          const i = floors.indexOf(f)
          const wantOpacity = i < selected ? 0.25 : 1
          f.object.traverse((m: any) => {
            if (!m.isMesh || !m.material) return
            const mats = Array.isArray(m.material) ? m.material : [m.material]
            for (const mat of mats) {
              if (mat.opacity === undefined) continue
              const o = mat.opacity
              if (Math.abs(o - wantOpacity) > 0.01) {
                mat.transparent = true
                mat.opacity = o + (wantOpacity - o) * Math.min(1, EASE * dt)
                moving = true
              }
            }
          })
        }
      }

      if (spinning) {
        pivot.rotation.y += ORBIT_SPEED * dt
        moving = true
      }

      if (moving) viewer.requestRender()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    function pick(index: number): void {
      selected = index
      setTargets()
      for (const b of controls.querySelectorAll('button')) b.classList.remove('on')
      controls.children[index + 1]?.classList.add('on')
      viewer.requestRender()
    }

    controls.replaceChildren(
      h('button', { type: 'button', class: 'on', onclick: () => pick(-1) }, 'Whole villa'),
      ...floors.map((f, i) => h('button', { type: 'button', onclick: () => pick(i) }, f.label)),
    )

    const spinButton = h('button', { type: 'button', title: 'Pause rotation' }, '❚❚')
    spinButton.addEventListener('click', () => {
      spinning = !spinning
      spinButton.textContent = spinning ? '❚❚' : '▶'
      last = performance.now()
      viewer.requestRender()
    })

    const bar = h(
      'div',
      { class: 'walk-bar' },
      spinButton,
      h(
        'button',
        {
          type: 'button',
          title: 'Fullscreen',
          onclick: () => {
            if (document.fullscreenElement) void document.exitFullscreen()
            else void stage.requestFullscreen?.()
          },
        },
        '⤢',
      ),
    )
    stage.append(bar)

    active = {
      viewer,
      stop: () => {
        cancelAnimationFrame(raf)
      },
    }
  }

  stage.append(controls)
  return stage
}
