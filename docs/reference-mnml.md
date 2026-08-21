# Reference scrape — mnml.ai — 2026-08-21

Capture of the tool catalogue behind `mnml.ai/explore`, an AI architecture-rendering
product. Unauthenticated, public surface only.

Everything below is **observed**, not inferred — from a headless-Chrome render of
`/explore` and the JSON that page fetches for itself. Nothing here is a claim
about how their renderer works internally; where their marketing says one thing
and their payload says another, both are recorded and the clash is marked.

Companion to `reference-scrape.md` (which covers propall.in, the primary
reference product). mnml.ai is a *different* shape of competitor: no 3D
walkthrough, no scene editor — it is a credit-metered image-generation catalogue.

---

## 1. What `/explore` is

Not a render gallery. It is a **tool directory**: `<h1>Architecture AI Tools</h1>`
over 15 cards. The community render gallery is a separate route, `/feed`
(reachable, HTTP 200, **not yet scraped**).

## 2. Method

Next.js App Router, client-rendered. Three fetch layers, only one carried data:

| Layer | Result |
|---|---|
| Raw HTML | Shell only |
| `Accept: text/markdown` (site advertises this for agents, see their `llms.txt`) | 869 bytes; their own header conceded `X-Original-Tokens: 15402` → `X-Markdown-Tokens: 217` |
| RSC flight payload (reassembled from `self.__next_f.push` chunks) | 30 KB, pure layout components, zero domain keys |
| **Rendered DOM + page-initiated XHR** | **The data** |

Data source is `api.mnml.ai/api/v1/explore/{tools,categories}`, captured
**passively** from the response stream while the page loaded it for itself — we
never crawled the API directly.

Robots position, checked rather than assumed: `mnml.ai/robots.txt` sets
`Content-Signal: search=yes, ai-input=yes, ai-train=no` and `Allow: /`, with
`Disallow: /api/` scoped to the `mnml.ai` origin. The data actually lives on
`api.mnml.ai`, a separate origin whose `robots.txt` 404s. `/explore` itself is
explicitly allowed. **`ai-train=no` — do not use any of this as model training input.**

---

## 3. The 15 tools

`credits` is their metering unit. Sorted by the site's own `displayOrder`.

| # | slug | Title | Category | Credits | Flags |
|---|---|---|---|---|---|
| 1 | `exterior-ai` | Exterior AI | Image tools | 10 | ★ top pick |
| 2 | `interior-ai` | Interior AI | Image tools | 10 | ★ top pick |
| 3 | `render-enhancer` | Render Enhancer | AI Enhancement | 10 | ★ top pick |
| 4 | `style-transfer` | Style Transfer Render | Image tools | 10 | ★ top pick |
| 5 | `canvas` | Edit & Modify (Canvas) | Edit & Modify | 10 | ★ top pick |
| 6 | `sketch2img` | Sketch to Image | Image tools | 10 | |
| 7 | `imagine-ai` | Imagine AI (Text-to-Image) | Image tools | 5 | |
| 8 | `masterplan-ai` | Masterplan AI | Image tools | 10 | |
| 9 | `landscape-ai` | Landscape AI | Image tools | 10 | |
| 10 | `virtual-staging-ai` | Virtual Staging AI | Image tools | 10 | ★ top pick |
| 11 | `4k-upscaler` | 4K Image Upscaler | AI Enhancement | 1 | |
| 12 | `prompt-generator` | Prompt Generator | Concept tools | 0 | ★ top pick, ⚠ free-clash |
| 13 | `concept` | AI Concept Generator | Concept tools | 0 (free) | |
| 14 | `design-assistant` | Design Assistant | Image tools | 20 | ★ top pick |
| 15 | `video-ai` | Video AI Animation | AI Enhancement | 100 | ★ top pick |

Live URL pattern: `https://mnml.ai/app/<slug>`.

**Price spread:** free → 1 (upscale) → 5 (text-to-image) → 10 (the standard
render tier, 9 of 15 tools) → 20 (conversational edit) → **100 (video)**. Video
costs 10× a still render, which is the single clearest signal in their pricing.

Per-tool one-line descriptions and their `popupDescription` how-it-works steps
are in the JSON/CSV — not restated here.

### Categories (4)

`Concept tools` (id 1) · `AI Enhancement` (id 2) · `Image tools` (id 3) · `Edit & Modify` (id 4)

---

## 4. The `experts` array — the notable finding

The same payload ships a second array of six "expert" entries, each naming the
model actually used:

| name | slug | category | editModel |
|---|---|---|---|
| Exterior AI | `exterior` | exterior | `google_nano_banana` |
| Interior AI | `interior` | interior | `google_nano_banana` |
| Masterplan AI | `masterplan` | masterplan | `google_nano_banana` |
| Landscape AI | `landscape` | landscape | `google_nano_banana` |
| Plan AI | `plan` | plan | `google_nano_banana` |
| Product AI | `product` | product | `google_nano_banana` |

All six route to **Gemini's Nano Banana image model**. Their `llms.txt` markets
the platform as *"ArchDiffusion v4.2 with proprietary ARX technology"*. Their own
API says Google. Treat the proprietary-model claim as unsupported by the
evidence we have.

Note `plan` and `product` appear as experts but have **no** corresponding
public tool card — either unreleased or dashboard-only.

---

## 5. Data quirks (theirs, not ours)

1. **Category label mismatch.** The UI filter chips render "Render tools"; the
   API calls that same category `Image tools`. We kept the API name. A join on
   the *label* would silently drop 8 of 15 tools.
2. **`isFree` is unreliable.** `concept` = `credits 0, isFree 1`.
   `prompt-generator` = `credits 0, isFree 0` — yet its badge renders "Free".
   Flag and price contradict each other. **We kept both readings** rather than
   picking a winner: every row carries `is_free_flag` (vendor's flag),
   `is_free_derived` (`credits === 0`, what the badge shows), and
   `free_disagreement` (true where they clash — currently only `prompt-generator`).
   Pick a side downstream, deliberately.
3. **`canvas` has no thumbnail** (14/15 tool thumbs resolved). Its API title is
   "Edit & Modify (Canvas)" but the card renders as **"Studio"** with a `New!`
   badge, so the title-join missed it. The image is still on disk as
   `thumb-studio-min.png`. All 15 URLs resolved correctly.

---

## 6. Assets — 16 files, 2.1 MB

Saved at **`A:\Tools\Scraping\node\mnml_assets\`**

- 14 tool thumbnails (`thumb-<slug>.png`), plus `thumb-studio-min.png`
- 2 logos (`mnml-logo.svg`, `mnml-logo-blue.svg`)

Downloaded as **un-resized originals**: the page serves them through Cloudflare's
image transform (`/cdn-cgi/image/width=384,quality=75,.../tools/thumb-x.png`);
the scraper strips the transform segment and pulls the source file. Both URLs are
recorded per asset in `mnml_explore_assets.csv`.

> ⚠ **Licensing — read before using.** These are mnml.ai's copyrighted marketing
> images and trademarked logos. They are competitive **reference material only**.
> Do not ship them in Arcvia's UI, docs, or marketing, and do not commit them into
> the Arcvia repo — which is why they live under `A:\Tools\Scraping\`, outside this
> project tree. Their robots policy is also `ai-train=no`.

---

## 7. Why this matters for Arcvia

Arcvia's current surface (per `architecture.md`) is **scene-based**: floor plan →
3D model → baked walkthrough → Cycles film. mnml.ai has none of that. It sells
**single-image generation, metered per render**, with no persistent scene.

Two things worth lifting, neither requiring their stack:

- **The credit-metering taxonomy.** A flat per-tool credit price with a visible
  badge on every card is a far simpler cost story than Arcvia's per-render
  Blender queue (`costs.md`). The 1 / 5 / 10 / 20 / 100 ladder is a ready-made
  reference for pricing tiers.
- **Category structure.** Four categories — concept / generate / enhance / edit —
  is a cleaner user-facing split than tool-by-tool listing, and maps onto
  capabilities Arcvia either has or has stubbed.

Direct overlap with existing Arcvia work: `masterplan-ai` ↔ the master-plan
hotspot exporter; `virtual-staging-ai` ↔ furniture placement; `4k-upscaler` ↔
render post-processing.

**Not yet captured:** `/feed` (the actual render gallery), `/pricing` (credit
pack costs — needed to convert credits→currency), and anything behind auth. **The authenticated Studio surface is now captured in section 9.**

---

## 8. Files

All under `A:\Tools\Scraping\node\`:

| File | Contents |
|---|---|
| `mnml_explore.json` | Full merged record — 15 tools, 6 experts, 4 categories, 16 assets, provenance |
| `mnml_explore_tools.csv` | 15 tools × 14 columns |
| `mnml_explore_experts.csv` | 6 expert→model mappings |
| `mnml_explore_assets.csv` | 16 assets: filename, alt, dimensions, bytes, origin URL, local path |
| `mnml_assets/` | The 16 downloaded files |
| `mnml_explore_scrape.js` | Re-runnable scraper — `cd /a/Tools/Scraping/node && node mnml_explore_scrape.js` |

Scraper needs system Chrome (`channel: 'chrome'`) — the Playwright headless-shell
binary is not installed on this machine, and the Playwright **MCP** profile is
often locked by a parallel session, so drive it as a script, not via the MCP.

Re-running overwrites all outputs in place and re-downloads assets.

---

## 9. The authenticated Studio surface — captured 2026-08-21

Section 7 above listed "anything behind auth" as not yet captured. This closes that
gap. A signed-in Studio space (`mnml.ai/studio/<uuid>`) was loaded with network
recording armed, and every request the page made for itself was observed
**passively** — nothing was crawled, no generation was triggered, no credits spent.

### The complete API surface the Studio calls

| Method | Endpoint |
|---|---|
| POST | `api.mnml.ai/api/v1/auth/validate-session` |
| GET | `api.mnml.ai/api/v1/user` |
| GET | `api.mnml.ai/api/v1/explore/tools` |
| GET | `api.mnml.ai/api/v1/studio/{spaceId}/info` |
| GET | `api.mnml.ai/api/v1/studio-layers/space/{spaceId}` |
| GET | `api.mnml.ai/api/v1/studio/{spaceId}/uploads` |
| GET | `api.mnml.ai/api/v1/studio/{spaceId}/input-images` |
| GET | `api.mnml.ai/api/v1/generations/space/{spaceId}?limit=20` |
| GET | `cdn.mnml.ai/user_uploads/alpha/user_generated/v3/{uuid}.png` |

Session auth is NextAuth on the `mnml.ai` origin (`/api/auth/session`), exchanged
for an API session against `api.mnml.ai` via `validate-session`. Two origins, one
session — the same split recorded in section 2.

### What the surface proves

**There is no geometry anywhere in this product.** The complete persistent state of
a Studio space is four collections: `uploads`, `input-images`, `studio-layers` and
`generations`. Every artifact resolves to a **`.png` on a CDN**.

There is no `/scene`, no `/model`, no `/mesh`, no `/geometry` endpoint. No `.glb`,
`.gltf`, `.obj`, `.ifc` or `.fbx` is requested or served. "Layers" are raster image
layers in the Photoshop sense, not scene-graph objects.

This settles the question the marketing leaves open. mnml does **not** reconstruct a
building from a plan. It runs image-to-image diffusion (Gemini `google_nano_banana`,
per the `experts` array in section 4) and stores the resulting pixels.

### The Studio UI, for feature reference

Observed from the rendered editor. Recorded because it is a well-judged taxonomy
worth learning from, not because the underlying capability is what it appears:

- **Engine** — `v4.4 Ultra` (30 credits, billed as "2K renders with deep reasoning")
  vs `v4.4 Fast`. Note 30 credits, against the 10-credit standard tier in section 3.
- **Expert** — Exterior · Interior · Masterplan · Landscape · Plan · Product ·
  Enhancer · Text-to-Render. Confirms section 4: `plan` and `product` are live in the
  Studio despite having no public tool card on `/explore`.
- **Render Style** — RAW · Auto · Photoreal · CGI · CAD · Freehand Sketch · Model ·
  Illustration · Watercolor.
- **Scene Effects Booster** — a toggle adding "atmospheric & photographic effects".
- **Camera Angle** — Auto | Manual.
- **Canvas toolbar** — add, rect-select, brush/mask, magic wand, crop, extend, eraser,
  Upscale, Enhance, Extender, Animate, delete.
- **Prompt panel** — Scenario `Render | Edit`, "Describe Image", `Input: Previous
  render`, and a user-settable **Seed**.
- **Right rail** — Renders → History | Layers | Adjust, with thumbnails.

### The two tells

Both are visible in the UI itself, and both are consequences of having no model:

1. **A user-settable Seed.** A renderer that owns geometry has no use for a seed —
   the same scene renders the same way every time. A seed control exists precisely
   because the output is sampled, not computed.
2. **"Camera Angle" that cannot orbit.** With no mesh, changing the angle cannot
   re-project a model; it can only generate a *fresh image* and hope the building
   comes back consistent. `Input: Previous render` is the mitigation, and it is a
   mitigation rather than a fix.

### Why this is the opening, not the threat

Arcvia already reads real geometry — `services/floorplan-ai/cad.py` resolves DXF
layers and units with an extents sanity-check, and `apps/studio` carries a planar-graph
wall model with rooms derived as minimal cycles. That is the capability mnml simulates
and cannot do.

The correct read of this taxonomy is therefore **inverted**: build the geometry engine,
then offer Engine / Expert / Style / Camera as controls over a *real* camera and a
*real* model, where cross-view consistency is free because it is the same building
every time. A diffusion pass stays available as an optional finish over a true Cycles
render — conditioned on real depth, normal and segmentation passes — rather than as the
source of truth.

> ⚠ Same licensing position as section 6. This is competitive reference material.
> Their robots policy remains `ai-train=no`. Nothing observed here was generated,
> downloaded into the repo, or paid for.
