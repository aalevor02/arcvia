# Reference scrape — 2026-08-18

A complete capture of the reference product (`propall.in` and its five sibling
apps), performed with an authenticated trial account. This supersedes the
partial teardown in `architecture.md` §1: that pass saw five deployed
components, this one found **six**, plus the storage design that explains the
cost profile.

Everything below is *observed*, not inferred — from crawled HTML, the shipped
JS bundles, and a live authenticated session in the editor.

---

## 1. Deployed surface

| Origin | What it is | Stack |
|---|---|---|
| `propall.in` | Marketing site, 15 pages | Astro 5.1.1, Tailwind v3 |
| `design.propall.ai` | **The editor.** 2D floor-plan + 3D scene | Vite + React + Three.js, 3.3 MB entry |
| `walkthrough.propall.ai` | **The publisher.** Bake, probes, checkpoints, render points | Vite SPA, 2.3 MB entry |
| `visualisation.propall.tech/<slug>/` | Published walkthroughs | Shapespark exports (licensed) |
| `play.propall.ai/<slug>/` | Master-plan explorer | Single inlined HTML + SVG hotspots |
| `walldetectapi.propall.in` | Floor-plan symbol detection | Python FastAPI |
| `expressglb.propall.in` | GLB processing service (answers `Pong`) | Express |

### The editor → publisher handoff

"Finalise Setup" in the editor does **not** open a panel. It navigates to:

```
https://walkthrough.propall.ai/{orgName}/{sceneName}/login?token={uuid}-{hmac}
```

The token comes from `POST /auth/generate-one-time-login-token` and is redeemed
at `POST /auth/one-time-login`. Two apps, one session, no shared cookie — which
is what lets them sit on different origins.

---

## 2. Backend: seven API Gateway deployments

| Id | Owns |
|---|---|
| `eda8nfsff3` | users, login, scene list/metadata, one-time login tokens |
| `x2anddp6n0` | organisation, credits, org scenes |
| `7xniro3c0e` | scenes: publish, bake, render, floor-plans, textures, logos, checkpoints |
| `0osjdgeg9c` | furniture catalog, HDRs, PDF/DWG uploads, local object uploads |
| `kojwavrjdd` | MongoDB object store (`/mongo/get-objects`, `/mongo/create-object`) |
| `v8p7438yw0` | payments |
| `kx3tlfqf83` | phone OTP |
| `m8v0gqt3i9` | Zoho CRM leads |

**44 endpoints** observed from the editor bundle alone. Full list in
`reference-endpoints.txt`.

### Storage design — the important part

Scene state never passes through Lambda. The client:

1. `GET /save-user-scene-url?sceneName=…` → presigned S3 PUT URL
2. `PUT` the scene **CBOR-encoded** to `scenes/{userId}/{sceneName}.cbor`

Same pattern for the floor-plan raster
(`saved-floorplans/{userId}/{scene}-{floorId}`) and the card thumbnail
(`saved/{userId}/{scene}/preview.webp`).

That is why a 3 MB scene graph costs nothing to save. Arcvia currently POSTs
scene JSON through Fastify — fine at this size, but this is the pattern to
adopt before scenes get large.

Baked output is fetched as either a single GLB or a **split-buffer format**
(`baked-split/`), chosen at load time — the split form streams.

---

## 3. Marketing site — 15 pages

`/` `/services` `/pricing` `/enterprise` `/referral` `/contactus` `/register`
`/login` `/reset-password` `/trial` `/post-payment-add-accounts` `/aboutus`
`/privacy-policy` `/refund-policy` `/terms-conditions`

### Homepage sections, in order

1. Hero — "AI Powered visualisation tools for real estate", two CTAs
   ("Experience 3D Walkthrough", "Start your 7 day free trial")
2. **How it Works** — 3 interactive tabs: Upload → Customize → Share, each with
   its own illustration and sub-chips (Lighting / Furniture / Paint / Materials)
3. **Why you should use** — 3 cards: finest details, all devices, unlimited
   static renderings
4. Enterprise block — 4 bullets, "Enterprise pricing" + "Book a demo"
5. Trust logos — "Organizations that trust us … and many more…"
6. Collaborative work — multi-architect editing, 4 bullets
7. Integrations — CAD/SketchUp/PDF ingest, dedicated support
8. **Referral program** — 10% recurring, monthly payouts, no cap,
   "10 referrals = ₹3.25 lakh+ per year", 4-step how-it-works
9. FAQ — 4 product + 6 referral questions

### Pricing page

- Countdown banner ("Introductory Offer — Ends in HH:MM:SS")
- Monthly / **Semi-annually** toggle, "Save 10%"
- 4 tiers: Free Trial (₹0/7 days, 1 user, 10 credits), Basic (₹3499, 1 user,
  50 credits), Professional (₹4999, unlimited users, 75), Enterprise (₹5999,
  unlimited users, 75)
- **Compare Plans** table — 10 feature rows
- Payment modal: billing name, address, GST number, **referral code**

### Trial page

Three states driven by account status: signed-out (register/sign-in), trial
active (name, days remaining, "Start Designing!" / "Buy a plan"), trial expired
(credits shown, "Check our plans").

### Header account menu (every page)

Welcome + name · Plan · Credits · **Copy referral code** · Go to Dashboard ·
Add Team Members · Sign Out.

---

## 4. The editor (`design.propall.ai`)

### Entry

Login → **Your Projects** table (Project / Last modified / Published / More
actions), search, sort. "Create New Project" offers three starts:

- **Upload Floorplan** — JPG, PNG, PDF, DWG (DWG converted server-side)
- **Draw a Floor Plan** — blank canvas
- **Upload GLB File** — skip straight to 3D

Then a setup step: **Design Theme** (16 options — Traditional, Bohemian,
Minimalistic, Contemporary, Modern, Rustic, Industrial, Mid Century, Japandi,
Art Deco, Mediterranean, Luxury, Neo Classical, Maximalism, Noir, Detection
Markers) + project name.

### 2D mode — tools

`AI Reader` · `Wall` · `Beam` · `Ceiling` · `Cutout` · `Floor Edge` · `Measure`
· `Delete`, plus a Settings tab.

Secondary bar: Edit Wall (single/all), Edit Beam (single/all), Separate
Flooring Material, Add false ceiling, Remove ceiling, Remove skirting, Change
Theme, Replace Current Floor, Copy Graph, Delete Current Floor, Multi-floor
switcher.

**Closing a wall loop auto-creates a room** — named ("Room 1"), dimensioned
(31'6" × 21'6" annotations on all four sides), and floor-filled with the theme
texture. Multi-floor mode can compare/align the current floor against another.

### 3D mode — tools

Grouped exactly like this in the panel:

- **Objects** — Furnish
- **Scale & Transform** — Measure, Cutout
- **Workflow** — Modelling
- **Material & Visibility** — Material, BOQ/BOM
- **Environment** — Add HDRI, Clear HDRI, Isometric, Diagram
- **Stairs** — Delete Stair Railings
- **Lights** — Edit Lights (Sunlight, sun colour/intensity, sun gizmo)
- **Manage Projects** — Save Scene, Export as GLB, Manage Walkthroughs,
  Preview Render
- **Camera Controls** — camera speed, minimap toggle

Top bar: 2D/3D toggle, **Finalise Setup**, still-render, walkthrough-render,
layers, account.

#### Modelling tool (a real sub-editor)

Box (1) · Cylinder (2) · Custom Shape (3) · Extrude (4) · Inset Face (5) ·
Face Cut (6) · Curve Cut (7) · Frame Extrude (8) · Dome Extrude (9) · Arc
Extrude · Delete. Plus CSG cutouts against walls/floors/ceilings, stair
generation from two parallel edges, and railing groups with configurable
handles (type, radius, width, height, frequency, connect/join).

#### Furnish catalog — 59 categories

Organisation Assets · Abstract · Bar (Floor) · Bar (Wall) · Bay window seaters
· Beds · Bedstand · BoardGames · BookShelves · Breakfast Counter · Cabinet ·
Carpet · Cars · Ceiling Decor · Chair · Curtains · Decor (Floor) · Decor (Wall)
· Dining Table · Doors · Electronics (Ceiling/Floor/Wall) · False Ceiling ·
Gate · Kitchen (Ceiling/Floor/Wall) · Kitchen Decor (Wall) · KitchenDecor
(Floor) · Lights (Ceiling/Floor/Wall) · Mirror · OutdoorEquipments ·
OutdoorSitOut · Painting · Partition separators · Partitions · Plants ·
Railing · Religious Misc (Floor/Wall) · Retail · Shelves · Single Seater Sofa ·
Sofa · Stairs · Swing · TV Cabinet · TV Unit · Table (Floor/Wall) · Wall panels
· Wardrobe&Storage · Washroom (Floor/Wall) · Windows · Stairs&escalator

Placement is surface-typed: **On-Floor, On-Wall, In-Wall, Ceiling** — an
in-wall object (window) cuts the wall via CSG on placement, and doors carry
hinge-side + swing-angle controls.

#### Material editor

Catalog / Upload file · Texture Library (Interior / Exterior / Miscellaneous) ·
texture scale · roughness / metalness / emissive colour + strength · "Apply
Changes" vs "Apply to This Object" · per-face material editing · separate
flooring material · UV normalise/revert.

#### BOQ / BOM

Generates a real `.xlsx` with two sheets and **embedded thumbnails**:

- *Bill of Quantities* — Name | Image | Dimensions(m) (L × B × H) | Quantity
- *Bill of Materials* — Material | Image | Dimensions(ft) (L × B) | Total Tiles
  | Total Area(ft²)

#### Renders

Resolution picker: **FHD 1920×1080 · 2K 2560×1440 · 4K 3840×2160 · 8K
7680×4320**. Separate cheaper paths: Preview Render (monthly quota, "Preview
render limit exhausted for month") and Isometric Render/Screenshot.

#### Other

Auto-save on a timer with explicit "Auto-save: On" state · undo/redo stack with
named commands · hidden-mesh manager with Unhide All · notes/annotations per
scene · construction diagram generation · export as GLB · socket connection
enforcing **one active session per user** ("User already logged in elsewhere").

---

## 5. The publisher (`walkthrough.propall.ai`)

- **Bake** — `POST /scenes/bake` with `samples`/`max_bounces`/`diffuse_bounces`/
  `hdri_path`; status polling, time-remaining, cancel, queue position
  ("In queue, waiting to start…")
- **Reflection probes** — add in front of camera, auto-generate, select/move
- **Checkpoints** — navigation waypoints
- **Views** — named camera shortcuts from the current position
- **Render points** — saved positions that can each be rendered FHD→8K
- **Autoplay & Record** — automatic tour playback and video capture
- **Hotspots** — info hotspots (title, description, image) and external links
- **Texture layers / object switching** — the configurator: swap materials and
  swap objects at view time (`bake-switch` resources)
- **Bill summary** — PDF quote (jsPDF + autoTable) for selected objects
- **Per-scene logo** upload, **login-gated scenes**, and a device limit
  ("Only 1 device is allowed to display scene")
- Credits are **subtracted per render resolution** with an explicit refund path
  ("Refund successful") when a job fails

---

## 6. What Arcvia does not have yet

Tracked in `docs/roadmap-parity.md`.
