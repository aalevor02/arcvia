# Architecture

This system was rebuilt from a teardown of a working production product
(`propall.in`). This document records what that system does, what was carried
over, and what was deliberately changed.

---

## 1. The reference system

Not one website — five deployed things under one brand.

| Component | Technology | Hosting |
|---|---|---|
| Marketing site | Astro 5.1.1, Tailwind v3, React islands | nginx 1.24 on a VPS |
| Studio (the product) | Vite + React + Three.js, 3.3 MB entry bundle | S3 + CloudFront |
| Published walkthroughs | **Shapespark** exports (third-party licence) | S3 + CloudFront |
| Master-plan explorer | Static HTML + SVG hotspots, 14.3 MB single file | S3 + CloudFront |
| Floor-plan detection | Python FastAPI / uvicorn | Separate host |
| Backend | **8** AWS API Gateway + Lambda services, ap-south-1 | AWS |

Supporting pieces: MongoDB, custom email/password auth returning
`uid`/`idToken`/`refreshToken`, Razorpay payments, phone OTP, Zoho CRM sync,
Socket.IO for multi-user editing, Calendry for demos.

### The render pipeline

The most important thing the teardown revealed. The studio does this:

1. Export the scene from Three.js to `preview.glb`, upload to S3
2. Export the light rig to `lights.json`, upload to S3
3. Upload an `env.hdr` environment map
4. `POST /scenes/bake` with `samples`, `max_bounces`, `diffuse_bounces`,
   `hdri_path`, camera position and rotation
5. Poll `/scenes/bake/status` every 1.5s until a PNG lands in S3

Those parameter names are **Blender Cycles** verbatim, and the client performs a
`{x, y: -z, z: y}` conversion immediately before the call — the standard
Three.js (Y-up) to Blender (Z-up) axis swap. There is a headless Blender render
farm behind that endpoint.

### Where the money goes

In rough order:

1. **GPU render workers.** Every preview, isometric and bake is GPU time.
2. **Shapespark licence.** The published walkthroughs are not in-house code.
3. **Eight Lambda stacks.** Eight deploy pipelines, eight CORS configs, eight
   sets of cold starts, for ~35 endpoints total.
4. S3 + CloudFront egress on multi-megabyte models.

The Astro marketing site is nearly free. It is not the problem.

---

## 2. What this rebuild keeps

The architecture was largely right, and is reproduced:

- **Astro static for marketing.** Correct choice. No server, no runtime cost,
  excellent Core Web Vitals. Kept exactly.
- **Separate origins for marketing / studio / published output.** Each has a
  completely different caching and scaling profile. Kept.
- **Three.js in the browser for interactive work, Blender for final quality.**
  The right split — real-time for iteration, path tracing for output.
- **Job queue with polling, not websockets.** A bake takes minutes; a dropped
  socket mid-render is a worse failure than a missed poll.
- **Presigned direct-to-storage uploads.** Large models never pass through the
  app server.

## 3. What was deliberately changed

### One API service, not eight

`services/api` exposes every endpoint the reference system had, under one
process, one CORS config, one deploy. Route groups (`/auth`, `/organisations`,
`/scenes`, `/render`, `/billing`) map 1:1 onto the old service boundaries, so
splitting them back out later is a routing change and nothing more.

The frontend knows exactly one base URL. The reference shipped eight hard-coded
into the bundle.

### Cost guards are structural, not aspirational

`services/api/src/lib/renderQueue.js` enforces three limits, all defaulting safe:

| Guard | Default | Why |
|---|---|---|
| `RENDER_MODE` | `local` | The expensive path is opt-in, not the fallback |
| `RENDER_CONCURRENCY` | `1` | Concurrency × GPU rate = worst-case burn |
| `RENDER_TIMEOUT_MS` | `600000` | A runaway scene cannot bill for hours |
| `RENDER_DAILY_CAP` | `500` | Circuit breaker against a submit-loop bug |

The daily cap *holds* jobs rather than failing them — a spend guard should not
look like an error to the user.

### Credits are a ledger, not a counter

`creditLedger` is append-only. Every spend, refund and grant is a row. A bare
counter cannot answer "where did 400 credits go?"; this can. Costs are priced by
what they actually cost you — `lightmapBake: 25` against `sceneSave: 0`.

### No Shapespark

Published walkthroughs render through the same Three.js viewer as the studio,
reading a baked lightmap produced by our own Blender worker. One less licence,
one less vendor, and the published output uses the same code path as the editor
so they cannot drift apart.

### Bundle splitting

The reference shipped a single 3.3 MB entry chunk, so a one-line UI change
invalidated the whole thing for every returning user. Here Three.js and React
get stable chunks:

```
three   522 kB  (changes ~2x/year)
react   142 kB  (changes rarely)
app      86 kB  (changes every deploy)
```

### Detection reads rooms, not lines

`services/floorplan-ai` has no model weights, no GPU and no per-call cost. It
runs anywhere and makes the product usable end-to-end today. A trained YOLO
backend slots in behind the same interface once weights exist, and real customer
plans flowing through the heuristic path are the training set for it.

**The reading runs backwards from the obvious direction, and that is the whole
design.** The natural pipeline — extract every long straight stroke, then decide
which are walls — cannot work on a furnished presentation plan. Nothing local to
a stroke settles it: a double bed is 2 m and a partition is 3 m, both are drawn
four pixels wide at brochure resolution, both are dark. Length, stroke weight,
colour and pixel texture were each measured against real drawings and none
separates them.

What separates them is what the line *does*. A wall bounds a room; a bed sits
inside one. So the detector seals doorways, floods the enclosed regions, and
keeps only the strokes lying on a region's edge. Furniture is rejected because
there is nothing behind it — and stair treads, hatching and the site boundary go
with it, without a rule for any of them.

Three things come out of the same pass:

* **Rooms**, returned directly. The detector has to find them anyway to know
  which strokes are walls, so sending only walls would throw that away.
* **Names**, from OCR of the drawing's own labels. An architect writes SHOWER
  inside the shower, and WARDROBE inside the wardrobe — which settles the one
  question no pixel measurement can, since a labelled fitting is joinery rather
  than structure.
* **Scale**, from the sizes printed beside those names. `SHOWER 7'0"X5'9"`
  compared against the region's size in pixels gives metres-per-pixel, and a
  dozen rooms agreeing beats one hand-drawn calibration line. The studio applies
  it only to an underlay nobody has calibrated by hand.

OCR (`rapidocr-onnxruntime`) is an optional extra. Without it the service still
runs, with unnamed rooms and a scale the user sets by hand. `/health` reports
`reads_text` so callers can say which they are getting.

PDF reading is `pypdfium2` + `pdfplumber`, both permissive and both in
`requirements.txt`; `/health` reports `reads_pdf`. A second reader, PyMuPDF, can
be selected with `ARCVIA_PDF_BACKEND=pymupdf` for diagnosis — it is **not** in
`requirements.txt` and a release never has it, because it is AGPL and AGPL
reaches network use. `/health` reports `pdf_backend` so it is always visible
which one produced a given result. See `services/floorplan-ai/requirements-dev.txt`.

### PDFs, because that is what people have

Almost nobody sends a drawing. They send the deck they showed the client: a
27-page slide document where page 3 carries two floor plans and the rest are
captioned interior renders.

`/document` describes such a file without extracting it, and `/document/page`
pulls one image out. Two facts make this work without any model. A PDF stores
its images at placed resolution, so the plan buried in a slide is a 4096px
original — a *better* source than a screenshot of the same page. And every image
is captioned, because the deck was made to be presented: "GROUND FLOOR -
BEDROOM (NORTH ORIENTED)" states what it is, which floor, and which room. That
caption is what pairs twenty-two renders with their rooms automatically.

Pixels are consulted only when the caption is silent, and then only to separate
a line drawing from a photograph.

The detector reports `low_confidence` — now including *no enclosed rooms*, which
is the signal that actually matters — and labels ambiguous gaps as `opening`
rather than guessing door-vs-window. A confident wrong answer that reaches a
client presentation is worse than an honest unknown.

### Local-first development

The whole stack runs with no cloud account, no Docker and no network: a JSON
file store, Blender on your own machine, OTP codes logged to the console instead
of sent. Infrastructure is a deployment concern, not a prerequisite for writing
code.

---

## 4. Request flow

```
Browser (studio)
  │  1. presigned PUT  ────────────────────► object storage   (.glb, .hdr, lights.json)
  │  2. POST /render/jobs ─────────────────► api
  │                                            │ charge credits (ledger row)
  │                                            │ axis-convert camera Y-up → Z-up
  │                                            │ enqueue
  │                                            ▼
  │                                         renderQueue
  │                                            │ concurrency / timeout / daily cap
  │                                            ▼
  │                                    Blender Cycles (local or GPU worker)
  │                                            │ stdout: "Sample 12/32" → progress
  │                                            ▼
  │  3. GET /render/jobs/:id  (backoff 1s→5s)  PNG → storage
  ▼
Result
```

Failure refunds the credits. Cancelling a *queued* job refunds; cancelling a
*rendering* job does not, because the GPU time was already spent.

---

## 5. Deployment shape

| Piece | Target | Notes |
|---|---|---|
| `apps/web` | Any static host / CDN | `npm run build` → `dist/` |
| `apps/studio` | Any static host / CDN | Same |
| `apps/planviewer` | Any static host | Exports are standalone files |
| `services/api` | One small VM or container | Stateless apart from the store |
| `services/floorplan-ai` | One small VM or container | CPU-only on the default backend |
| `services/render-worker` | GPU machine, **on demand** | The only expensive line item |

The render worker is the only component that needs a GPU. Run it on a spot or
preemptible instance and start it from the queue rather than leaving it warm —
an idle GPU box bills exactly the same as a busy one.
