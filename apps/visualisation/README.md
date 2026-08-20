# Published visualisation

A complete project presentation — overview, interactive master plan, per-configuration
drawings with room schedules, gallery, and a 3D walkthrough — driven entirely by one
data file.

Currently carries **Casa Altinho** (Fair Green Ventures, Saipem, Goa).

```bash
npm run dev:vis      # http://localhost:5175
npm run build --workspace=apps/visualisation
```

## Why this exists

The system this platform was rebuilt from published one of these per unit, using a
third-party walkthrough licence (Shapespark) for the 3D and hand-built static HTML for
everything around it. A comparable published page for another project ships **75 MB**:
27 MB of raw geometry buffers, 24 MB of Basis texture atlases, 19 MB of baked lightmaps.

This app replaces the hand-built part and renders the 3D through
`@arcvia/viewer` — the same viewer the studio editor uses, so the editor preview and
what a client sees cannot drift apart.

## Routes

| Route | Page |
|---|---|
| `#/` | Overview — hero, key figures, narrative sections, configurations, gallery, location |
| `#/plan` | Interactive master plan; every plot is a hotspot, filterable by configuration |
| `#/villas` | All configurations |
| `#/villa/:typeId` | Drawings: floor switcher, plan image, full room schedule, area table |
| `#/walkthrough/:typeId` | 3D walkthrough, or an explicit account of what it still needs |
| `#/gallery`, `#/contact` | Renders, enquiry details |

Hash routing, not history routing: published output gets dropped into whatever folder a
client already has, and a hash needs no rewrite rule to survive a deep link.

## Adding another project

1. Write `src/data/<project>.ts` against the `Project` interface in `src/types.ts`.
2. Put its images under `public/`.
3. Change the import in `src/main.ts`.

Nothing else is project-specific. The palette in `styles.css` is the one place a new
client's identity needs applying — published output wears the *client's* brand, not
Arcvia's, and the platform's only mark is the "Made using Arcvia" credit in the footer.

## Master-plan hotspots

Polygons are stored as `[x, y]` percentage pairs, 0–100, and the overlay is
`viewBox="0 0 100 100" preserveAspectRatio="none"`. Percentages because the plan scales
to whatever width the page gives it; coordinates captured at one size are wrong at every
other. Note that `preserveAspectRatio="none"` stretches the viewBox, so a circle would
render as an ellipse — every marker is a polygon or text.

To author them for a new project, use `apps/planviewer`, which draws zones in the same
coordinate space and exports them.

**The plan image must have `height: auto`.** It carries `width`/`height` attributes so
the browser can reserve its box, and those attributes also set a presentational height —
`max-width` alone scales the width and leaves the height intrinsic, giving a vertically
stretched plan whose hotspots still look aligned because the overlay stretches with it.

## Turning a walkthrough on

Add a `walkthrough` block to the villa type:

```ts
walkthrough: {
  model: 'scenes/villa-e1.glb',      // Draco-compressed, lightmaps baked in
  environment: 'scenes/sky.hdr',     // optional
  eyeHeight: 1.6,
  views: [
    { id: 'living', name: 'Living area', position: [2.1, 1.6, -4.3], rotation: [130, -4] },
  ],
}
```

`rotation` is `[yaw, pitch]` in degrees — authors think in "facing which way", not in
quaternions. The route detects the block and swaps in the renderer.

### Payload discipline

Three.js is ~522 kB and the viewer another ~86 kB. Neither is in the entry bundle:

- `walkthrough.ts` — the route and the "no model yet" state. **No Three import.** 3 kB.
- `walkthrough-live.ts` — the renderer. Dynamically imported *only* when a type actually
  has a `walkthrough` block.

So the entry chunk is 40 kB (12 kB gzip), and a visitor who opens a floor plan never
downloads a WebGL runtime. Keep it that way: a single static import of `@arcvia/viewer`
anywhere in the entry graph silently undoes it.

## Current state

The site is complete and driven by real data — 19 units, 5 configurations, every room
name and dimension transcribed from the architect's drawings.

**No walkthrough is live**, because the source archive contains no 3D geometry: the CAD
is 2D, the renders are flat images. `#/walkthrough/:typeId` therefore renders the pending
state, which names exactly what is missing. Five bakes cover all nineteen villas, since
only five distinct configurations exist.
