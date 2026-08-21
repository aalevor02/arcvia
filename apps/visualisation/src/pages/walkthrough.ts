import type { Project, VillaType } from '../types'
import { h } from '../ui/dom'

/**
 * The walkthrough route.
 *
 * Structurally the same page as the reference product's unit walkthrough: a
 * cover image gated behind an explicit play action, then a first-person scene
 * with named view bookmarks and a small toolbar.
 *
 * This module deliberately contains no Three.js import. Most visits to this
 * route today land on the "no model yet" state, and shipping a WebGL runtime to
 * render a paragraph of text would be indefensible on a mobile connection. The
 * renderer arrives only once there is something to render.
 */

let releaseLive: (() => void) | null = null

export function disposeWalkthrough(): void {
  releaseLive?.()
  releaseLive = null
}

export function walkthroughPage(project: Project, typeId: string): HTMLElement {
  const type = project.villaTypes.find((t) => t.id === typeId)

  if (!type) return notFound()
  if (!type.walkthrough) return pendingScene(project, type)

  // A scene exists — now the renderer is worth its weight.
  const host = h(
    'div',
    { class: 'band' },
    h('div', { class: 'shell' }, h('p', { class: 'muted' }, 'Starting the viewer…')),
  )

  // The model view, not the first-person walk. The geometry is derived from 2D
  // plans, so it is sound as massing but the upper levels have few enclosing
  // walls — the drawings show open terraces, not rooms. Walking put the visitor
  // outside the building within two steps. `walkthrough-live` is still here for
  // any type that gets a properly enclosed model.
  void import('./dollhouse-live').then((module) => {
    if (!host.isConnected) return
    releaseLive = module.disposeLive
    host.replaceWith(module.liveScene(type))
  })

  return host
}

// ---------------------------------------------------------------------------

/**
 * What the visitor sees before geometry exists.
 *
 * Deliberately explicit rather than a spinner or a "coming soon" card. A
 * walkthrough needs a modelled, textured, lightmapped scene; that is an archviz
 * deliverable, not something the site can conjure. Saying exactly what is
 * missing is more useful to the developer than an empty page, and more honest
 * to a buyer than a promise with no date on it.
 */
function pendingScene(project: Project, type: VillaType): HTMLElement {
  const shared = type.appliesTo.length

  return h(
    'main',
    {},
    h(
      'section',
      { class: 'villa-hero' },
      h('img', { src: `renders/${type.renders[0]}.webp`, alt: type.name }),
      h(
        'div',
        { class: 'caption' },
        h(
          'div',
          { class: 'shell' },
          h('p', { class: 'kicker', style: 'color:#c9a86a' }, '3D walkthrough'),
          h('h1', {}, type.name),
        ),
      ),
    ),
    h(
      'section',
      { class: 'band' },
      h(
        'div',
        { class: 'shell' },
        h(
          'div',
          { class: 'split' },
          h(
            'div',
            { class: 'lede' },
            h('h2', {}, 'The viewer is ready; the model is not'),
            h(
              'p',
              {},
              'This page is wired to render a first-person walkthrough of ' +
                `${type.name} — view bookmarks, guided tour and all. It needs one thing: the villa as 3D geometry.`,
            ),
            h(
              'p',
              {},
              'The drawing set here is two-dimensional, and the renders are flat images. ' +
                'Neither can be walked through. The archviz studio that produced the renders already ' +
                'holds the modelled, furnished and textured scene they were rendered from — that file ' +
                'is what turns this page on.',
            ),
            h(
              'p',
              { style: 'margin-top:24px' },
              h('a', { class: 'btn solid', href: `#/villa/${type.id}` }, 'View the drawings instead'),
            ),
          ),
          h(
            'div',
            { class: 'notice' },
            h('h3', {}, 'What the walkthrough needs'),
            h('p', {}, 'From the studio that produced the renders, for this configuration:'),
            h(
              'ul',
              {},
              h('li', {}, 'The scene file (.blend, .max or .fbx) with furniture and materials intact'),
              h('li', {}, 'Texture maps as referenced by those materials'),
              h('li', {}, 'The camera positions used for the existing renders, if they were saved'),
            ),
            h(
              'p',
              { style: 'margin-top:14px' },
              'From there the pipeline is the platform’s own: geometry cleanup, a Cycles lightmap ' +
                'bake, KTX2 texture compression, and a Draco-compressed GLB served to this viewer. ' +
                'The comparable published page for another project ships 75 MB; a baked and ' +
                'compressed build of this villa should land well under that.',
            ),
            h(
              'p',
              { class: 'muted', style: 'font-size:12px;margin-top:14px' },
              shared === 1
                ? `${project.name} · one unit uses this configuration: ${type.appliesTo[0]}.`
                : `${project.name} · ${shared} units share this configuration, ` +
                  `so a single bake covers ${type.appliesTo.join(', ')}.`,
            ),
          ),
        ),
      ),
    ),
  )
}

function notFound(): HTMLElement {
  return h(
    'main',
    { class: 'band' },
    h(
      'div',
      { class: 'shell' },
      h('h2', {}, 'Unknown configuration'),
      h('p', { class: 'muted' }, 'That villa type is not part of this project.'),
      h('a', { class: 'btn', href: '#/plan' }, 'Back to the master plan'),
    ),
  )
}
