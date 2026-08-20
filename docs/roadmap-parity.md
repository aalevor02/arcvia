# Parity roadmap

What the reference product has that Arcvia does not, ranked by how much it
matters. Derived from `reference-scrape.md` (2026-08-18); editor section
updated 2026-08-20.

Status keys: **done** · **partial** · **todo** · **won't** (with a reason).

---

## Marketing site (`apps/web`, port 4321)

| Feature | Status | Note |
|---|---|---|
| Sign-in page | **done** | `/login/`, with a validated `?next=` redirect |
| Password reset | **done** | `/reset-password/`, one page for both steps |
| Account menu in header | **done** | Plan, credits, referral code, studio, team, sign out |
| Referral programme + dashboard | **done** | `/referral/`; tracking always on, payouts gated on billing |
| Referral code on signup | **done** | `?ref=` prefill, live validation, self-referral rejected |
| Team members page | **done** | `/team/` — a permanent page, not post-payment only |
| Services page | **done** | `/services/` |
| Privacy / terms / refund | **done** | `/privacy/` `/terms/` `/refund/` |
| Trial page | **done** | `/trial/` — honest "no trial to start" while billing is off |
| Plan comparison table | **done** | Generated from `plans.config.mjs`, both billing modes |
| Interactive how-it-works | **done** | Tabbed island, auto-advance, stops on interaction |
| Collaboration / integrations sections | **done** | |
| Favicon + touch icon | **done** | Generated from `brand.config.mjs` at build |
| Hero media | **partial** | Illustrated SVG stands in for a real product capture |
| Customer logos ("trusted by") | **todo** | Needs real customers; a fake logo wall is worse than none |
| Countdown / "introductory offer" banner | **won't** | Manufactured urgency on a free product |
| Payment modal (GST, billing address) | **won't** | `billingEnabled: false`. Ships with billing, not before |
| Monthly / semi-annual toggle | **won't** | Same — the table already handles both modes |

## Editor (`apps/studio`, port 5173)

The 2D floor-plan editor and the project dashboard are built (2026-08-20). The
3D side generates geometry from the plan but has no authoring tools yet.

| Feature | Status |
|---|---|
| Project dashboard (list, search, sort, duplicate, delete, published badge) | **done** |
| Three project starts: draw / upload floorplan / upload GLB | **partial** — draw and upload-floorplan are wired end to end; GLB import is not, and the editor says so plainly |
| Cross-origin sign-in hand-off (site → studio) | **done** — one-time 30s ticket, mirrors the reference's `generate-one-time-login-token` |
| 2D: wall, select, delete, measure | **done** |
| 2D: auto room detection + areas + dimension annotations | **done** |
| 2D: wall welding, T-junction and crossing splits | **done** |
| 2D: axis snap (on by default, Shift releases), vertex/wall/grid snapping | **done** |
| Multi-floor: add, duplicate to a new storey, delete, switch | **done** |
| Undo / redo | **done** — snapshot history, one entry per gesture |
| Auto-save on a timer | **done** — debounced, with a dirty/saving/saved indicator |
| Imperial and metric display, with dimension parsing | **done** |
| 3D: geometry generated from the plan (walls, slabs, ceilings, storeys) | **done** |
| Renders: preview / isometric / full / bake from the 3D view | **partial** — UI + API + worker exist end to end |
| 2D: beam, ceiling, cutout, floor-edge tools | **todo** |
| PDF / DWG underlays (the reference converts server-side) | **todo** — raster only for now |
| 16 design themes at project setup | **todo** |
| Floor-plan underlay to trace over | **done** — upload, scale calibration, opacity, invert, lock |
| AI floor-plan read ("Read the plan for me") | **done** — proxied through the API with auth, metering and refunds; face-pairing and corner-joining turn detector ink into walls |
| Furnish catalogue, surface-typed placement | **done** — 46 items in 9 categories, parametric geometry; floor / wall / in-wall / ceiling placement with snapping |
| Real 3D models in the catalogue | **todo** — geometry is parametric; `PlacedObject.customUrl` is the seam for GLBs |
| 3D: material editor, texture library, per-face materials | **todo** |
| 3D: modelling tool (box, cylinder, extrude, inset, cuts, dome/frame/arc) | **todo** |
| 3D: stairs from two parallel edges, railing groups + handles | **todo** |
| 3D: CSG cutouts against walls/floors/ceilings | **partial** — rectangular openings are split, not subtracted (exact and cannot fail); CSG only needed for arched or angled ones |
| Doors and windows, cutting the wall | **done** — plan symbols with swing arcs, hinge side and swing angle; walls split around openings in 3D |
| Lights: sun colour/intensity, gizmo, per-fixture editing | **todo** |
| BOQ / BOM export as `.xlsx` with embedded thumbnails | **todo** |
| Export as GLB | **todo** |
| One-session-per-user enforcement | **todo** |

### How the plan is modelled

Worth knowing before extending it. Walls are a **planar graph** — vertices and
edges — and rooms are *derived* as its minimal cycles, recomputed on every
change (`src/plan/rooms.ts`). Rooms are never stored.

That is why a shared wall behaves correctly: it is one edge belonging to two
faces, not two coincident polygon edges. It is also why room names are keyed by
a hash of the cycle rather than an index — edit a wall elsewhere on the floor
and the name stays where it was.

Interior faces come out counter-clockwise and the outer boundary clockwise, so
the *sign* of the shoelace area separates a room from the outside of the
building. No "largest polygon is the exterior" heuristic, which breaks on
courtyards and on plans with two disconnected wings.

Everything in the model is **metres**. Feet and inches are a display format
(`src/lib/format.ts`) applied at the edge.

197 tests cover the graph, the store, unit formatting, the 3D builder, the
underlay, detector conversion and the catalogue: `npm test -w apps/studio`. The API adds 53 more, including upload type-confusion, path traversal and SSRF cases on the
detect proxy: `npm test -w services/api`.

**Detector output is ink, not walls.** A drawn wall is two parallel lines, so
47 detected segments are ~24 walls. `detections.ts` pairs the faces (thickness
comes out *measured*, e.g. 9.4" for a nine-inch brick wall) and then joins the
corners — without that second step the walls render perfectly and enclose
nothing, because trimming leaves each centreline half a thickness short.

## Publisher

The reference runs this as a **sixth application** (`walkthrough.propall.ai`),
entered from the editor via a one-time login token. Arcvia has no equivalent
app; `apps/visualisation` publishes output but has no authoring console.

| Feature | Status |
|---|---|
| Lightmap bake console (queue, progress, time remaining, cancel) | **partial** — API + `render.py` exist, no UI |
| Reflection probes (manual + auto) | **todo** |
| Checkpoints / named views / render points | **todo** |
| Autoplay & record | **todo** |
| Info hotspots and external links | **partial** — `apps/planviewer` does hotspots for master plans |
| Object & material switching (the configurator) | **todo** |
| Per-scene logo, login-gated scenes, device limit | **todo** |
| PDF bill summary for selected objects | **todo** |

---

## Architectural changes worth adopting

1. **Presigned-PUT scene storage.** The reference never sends a scene through
   its API: it asks for a presigned S3 URL and PUTs CBOR straight to storage.
   Arcvia POSTs scene JSON through Fastify, which is fine at current sizes and
   will not be once scenes carry furniture and baked data. Adopt before that.

2. **Split-buffer baked output.** Baked scenes load as either one GLB or a
   split-buffer directory chosen at load time. The split form streams; the GLB
   is the fallback.

3. **Editor / publisher separation.** Two apps against one scene store, joined
   by a one-time token, keeps the 3 MB editor bundle out of the publishing
   workflow entirely.

---

## Deliberately not copied

- **Eight API Gateway deployments.** One API, one CORS config, one deploy.
- **Payment gates and trial clocks.** `billingEnabled: false` is a product
  decision, and every feature here respects it rather than working around it.
- **A licensed third-party walkthrough exporter.** `packages/viewer` is ours.
