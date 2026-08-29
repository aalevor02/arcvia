# Deploying Arcvia

Four things ship, and only one of them costs real money to run.

| Piece | What it needs | Rough cost |
|---|---|---|
| `apps/web` — marketing + published walkthroughs | Any static host | pennies |
| `apps/studio` — the editor | Any static host | pennies |
| `services/api` — Fastify | One small always-on Node process | ~$5–10/mo |
| `services/render-worker` — Blender Cycles | CPU or GPU, on demand | the only real cost |

The split is deliberate. Two static bundles and one small API is a stack that
costs almost nothing until somebody bakes something, and baking is the one
operation worth charging for.

---

## 1. The static apps

Both build to plain files. There is no Node process in production for either.

```bash
npm run build --workspace apps/web      # -> apps/web/dist
npm run build --workspace apps/studio   # -> apps/studio/dist
```

### One rewrite rule is required

Published walkthroughs live at `/view/<slug>/`, and a slug cannot be
prerendered — scenes are published long after the build. One static HTML file
serves every walkthrough ever published and reads its slug from the path at
runtime, which needs the host to rewrite:

```
/view/*  ->  /view/index.html   (200, not 301)
```

`apps/web/public/_redirects` already carries this in Netlify's format. For
other hosts:

- **Vercel** — `{ "rewrites": [{ "source": "/view/(.*)", "destination": "/view/index.html" }] }`
- **Cloudflare Pages** — reads `_redirects` as-is
- **nginx** — `location /view/ { try_files $uri /view/index.html; }`
- **S3 + CloudFront** — a CloudFront Function on viewer-request, or the
  error-document trick pointed at `/view/index.html`

**200, not 301.** A redirect rewrites the address bar and the page loses the
slug it was about to read.

Without the rule the product still works; links just look like
`/view/?s=<slug>` instead of `/view/<slug>/`.

### Environment

Both apps read their API host at build time, falling back to the page's own
hostname on port 8787 — which is right for development and wrong for
production.

```bash
# apps/web
PUBLIC_API_URL=https://api.example.com

# apps/studio
VITE_API_URL=https://api.example.com
VITE_SITE_URL=https://example.com     # where published links point
```

---

## 2. The API

```bash
npm run build            # nothing to compile; this validates the workspaces
NODE_ENV=production node services/api/src/server.js
```

### Required in production

```bash
JWT_SECRET=<32+ random bytes>    # the server refuses to start without it
WORKER_SECRET=<random>           # shared with the render worker
DB_PROVIDER=sqlite
DB_PATH=/var/lib/arcvia/arcvia.sqlite
STORAGE_PROVIDER=s3
S3_BUCKET=<bucket name>
S3_REGION=ap-south-1
S3_PUBLIC_URL=https://cdn.example.com
# Prefer the host's workload identity. If unavailable:
S3_ACCESS_KEY_ID=<server-only key>
S3_SECRET_ACCESS_KEY=<server-only secret>
# Local staging for CAD inputs downloaded from the bucket:
UPLOAD_DIR=/var/lib/arcvia/staging
BLENDER_PATH=/usr/bin/blender
SMS_PROVIDER=twilio
MAIL_PROVIDER=resend
```

`JWT_SECRET` is enforced: `services/api/src/lib/auth.js` throws at boot if
`NODE_ENV=production` and it is unset, rather than silently using the
development constant and issuing tokens anyone can forge.

### CORS

`isOriginAllowed()` in `services/api/src/lib/origins.js` accepts loopback and
RFC1918 origins outside production, and *strictly* the configured list inside
it — no pattern matching. Set it before deploying:

```bash
ALLOWED_ORIGINS=https://example.com,https://studio.example.com
```

Miss it and the studio fails to reach the API with a message that
looks like a network error — `fetch` rejects identically for a dead server and
a CORS refusal, so rejected origins are logged server-side because otherwise
the failure leaves no trace anywhere.

### Storage

Production uses the S3-compatible driver in `services/api/src/lib/storage.js`.
It uploads content-addressed immutable objects, skips duplicates after a HEAD
check, serves through `S3_PUBLIC_URL`, and deletes through the provider API.
`S3_ENDPOINT` and `S3_FORCE_PATH_STYLE` cover compatible providers such as R2
or MinIO.

CAD tools still require a local path. `pathOf()` downloads the requested object
atomically into `UPLOAD_DIR` before spawning the CAD subprocess, so that
directory is a staging/cache volume rather than the source of truth. Keep the
bucket private and give the API role only read/write/delete on its bucket prefix.
Put the configured CDN in front of the bucket.

### Account delivery

Arcvia's production drivers are explicit: Twilio sends Indian mobile OTPs and
Resend sends password-reset email. Set `SMS_PROVIDER=twilio` with
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`; set
`MAIL_PROVIDER=resend` with `RESEND_API_KEY` and `MAIL_FROM`. Production
refuses to start when either channel is absent or half-configured, so an auth
flow can never claim that a code or link was sent when no provider call
occurred.

Provider accounts, sender verification, Indian DLT registration where required,
and DNS records are external setup. No provider secret belongs in Git or a
frontend build variable.


---

## 3. The render worker

The only piece with a real bill attached.

```bash
RENDER_MODE=local          # spawns Blender here. The default, on purpose.
RENDER_CONCURRENCY=1       # raising this multiplies worst-case burn linearly
RENDER_TIMEOUT_MS=600000   # 10 min, stills
BAKE_TIMEOUT_MS=2700000    # 45 min, bakes
RENDER_DAILY_CAP=500       # holds rather than fails once hit
```

### On GPUs

Cycles falls back to CPU without a CUDA or HIP device, and it says so:
`ARCVIA_DEVICE:CPU` on stdout, surfaced in the editor as "Rendering on the
CPU". Measured here, on CPU:

| Scene | Meshes | Bake |
|---|---|---|
| Single room | 5 | ~4.5 min |
| Furnished living room | 79 | ~30 min |

A GPU takes that to roughly a tenth. It is not worth buying until somebody is
waiting on a bake — it buys throughput, and throughput is not the constraint
until there are clients.

### Boot reconciliation
### Starting capacity

Arcvia has no provider-specific infrastructure manifest, so set resources in
the chosen host's control plane. Start the API and SQLite on one 1-vCPU, 2 GB
RAM instance with a 10 GB persistent SSD. Start floor-plan AI on 4 vCPU and
8 GB RAM. Start each render worker on 8 vCPU, 32 GB RAM, and one GPU with at
least 16 GB VRAM.

Keep `RENDER_CONCURRENCY=1` and `RENDER_DAILY_CAP=500`. SQLite means exactly
one API instance until the PostgreSQL migration described below. This machine
currently exposes no compatible Blender GPU, so it is a CPU development
fallback rather than the selected production render worker.


The queue's `running` map is in memory. Any job still claiming to be queued or
rendering at boot is by definition abandoned — the process that owned it is
gone — so `reconcileRenderJobs()` fails and refunds them before the API accepts
traffic. Without it a deploy silently costs users credits for work that died
mid-flight.

---

## 4. Before the first client

- [ ] `JWT_SECRET` and `WORKER_SECRET` set to real random values
- [ ] `ALLOWED_ORIGINS` set to the production origins
- [ ] `/view/*` rewrite configured at the host
- [ ] `DB_PROVIDER=sqlite` and `STORAGE_PROVIDER=s3` selected
- [ ] Private bucket access and `S3_PUBLIC_URL` configured
- [ ] Twilio and Resend senders verified and server-only secrets installed
- [ ] `DB_PATH` and `UPLOAD_DIR` on persistent storage, and backed up —
      SQLite is the database of record; the bucket is object storage; and
      `UPLOAD_DIR` remains available as CAD staging
- [ ] `PUBLIC_API_URL` / `VITE_API_URL` / `VITE_SITE_URL` set at build time
- [ ] A published scene opened from a device that has never seen the studio,
      which is the only test that exercises CORS, the rewrite and the public
      payload together

## Known limits worth knowing before you sell against them

- **Atlas resolution is fixed at 2048.** A scene is packed into a
  ceil(sqrt(n)) grid, so 158 meshes get about 157 px each. Fine for soft
  lighting, thin for a large scene — the resolution should scale with mesh
  count and currently does not.
- **SQLite is a single-API-instance production store.** WAL and immediate
  transactions make one always-on API process durable. Before horizontally
  scaling the API, migrate this collection-shaped adapter to PostgreSQL.
- **Access codes gate the manifest, not the files.** The model and atlas stay
  content-addressed and unauthenticated. It stops a forwarded link being
  opened; it is not encryption.
