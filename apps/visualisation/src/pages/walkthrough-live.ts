import { SceneViewer, WalkController, type SceneView } from '@arcvia/viewer'
import type { VillaType } from '../types'
import { h } from '../ui/dom'

/**
 * The live 3D walkthrough.
 *
 * Split into its own module so that importing it is the *only* way Three.js
 * enters the bundle. The page that explains a missing model has no business
 * costing a visitor half a megabyte of WebGL.
 */

let active: { viewer: SceneViewer; walk: WalkController; stopTour: () => void } | null = null

export function disposeLive(): void {
  active?.stopTour()
  active?.walk.dispose()
  active?.viewer.dispose()
  active = null
}

export function liveScene(type: VillaType): HTMLElement {
  const scene = type.walkthrough!
  const canvas = h('canvas')
  const stage = h('div', { class: 'walk' }, canvas)

  const status = h('p', { class: 'weight' }, describeWeight(scene.views.length))
  const viewList = h('div', { class: 'walk-views', style: 'display:none' })

  const enter = h('button', { class: 'btn', type: 'button' }, 'Enter the villa')
  const cover = h(
    'div',
    { class: 'walk-cover', style: `background-image:url(renders/${type.renders[0]}.webp)` },
    h(
      'div',
      { class: 'walk-gate' },
      h('h2', {}, type.name),
      h(
        'p',
        {},
        'A first-person walkthrough. Drag to look, W A S D or the arrow keys to move, shift to move faster.',
      ),
      status,
      h('p', { style: 'margin-top:22px' }, enter),
    ),
  )
  // `start` now rejects when the model cannot be loaded, rather than resolving
  // as though it had worked. `onError` has already put the reason on screen and
  // re-enabled this button, so there is nothing to add here — but the rejection
  // still has to be consumed, or it surfaces in the visitor's console as an
  // unhandled promise rejection. The value of the throw is that everything after
  // the load in `start` no longer runs against an empty scene.
  enter.addEventListener('click', () => void start().catch(() => {}))
  stage.appendChild(cover)

  async function start(): Promise<void> {
    enter.setAttribute('disabled', 'true')
    status.textContent = 'Loading…'

    const viewer = new SceneViewer({
      canvas,
      onProgress: (fraction) => {
        status.textContent = `Loading… ${Math.round(fraction * 100)}%`
      },
      onError: (error) => {
        status.textContent = error.message
        enter.removeAttribute('disabled')
      },
      onReady: () => {
        cover.remove()
        viewList.style.display = ''
        if (scene.views.length > 0) select(0)
      },
    })

    const walk = new WalkController(viewer, canvas, { eyeHeight: scene.eyeHeight })
    active = { viewer, walk, stopTour }

    if (scene.environment) await viewer.loadEnvironment(scene.environment)
    await viewer.loadModel(scene.model)

    // Orbit is the studio's default; a published interior wants walk.
    walk.enable()
  }

  let settle: number | undefined
  function select(index: number): void {
    const view = scene.views[index]
    if (!view || !active) return
    active.viewer.goToView(view as SceneView)

    // The walk controller owns yaw and pitch. Without re-reading them after the
    // transition finishes, the next drag snaps back to the heading held before
    // the view change. 1.2s matches the easing duration in goToView.
    clearTimeout(settle)
    settle = window.setTimeout(() => active?.walk.syncFromCamera(), 1200)

    for (const button of viewList.querySelectorAll('button')) button.classList.remove('on')
    viewList.children[index]?.classList.add('on')
  }

  viewList.replaceChildren(
    ...scene.views.map((view, index) =>
      h('button', { type: 'button', onclick: () => select(index) }, view.name),
    ),
  )

  let cursor = 0
  let tourTimer: number | undefined
  const tourButton = h('button', { type: 'button', title: 'Guided tour' }, '▶')

  function stopTour(): void {
    clearInterval(tourTimer)
    clearTimeout(settle)
    tourTimer = undefined
    tourButton.textContent = '▶'
  }

  tourButton.addEventListener('click', () => {
    if (tourTimer !== undefined) {
      stopTour()
      return
    }
    select(cursor % scene.views.length)
    tourButton.textContent = '❚❚'
    tourTimer = window.setInterval(() => {
      cursor += 1
      select(cursor % scene.views.length)
    }, 6000)
  })

  const bar = h(
    'div',
    { class: 'walk-bar' },
    tourButton,
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

  stage.append(viewList, bar)
  return stage
}

function describeWeight(viewCount: number): string {
  return `${viewCount} view${viewCount === 1 ? '' : 's'} · loads on demand over your connection`
}
