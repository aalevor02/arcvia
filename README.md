# Arcvia

Real-estate visualisation platform: marketing site, in-browser 3D studio,
Blender render pipeline, floor-plan detection, and a master-plan hotspot tool.

Rebuilt from a teardown of an existing production system — see
[`docs/architecture.md`](docs/architecture.md) for what was inherited, what was
deliberately changed, and why.

**Billing is off.** Everything is free. The plan and credit model exists and
meters usage, but no payment path is active. See
[`packages/brand/plans.config.mjs`](packages/brand/plans.config.mjs).

---

## Layout

```
apps/
  web/           Astro 5 marketing site        -> static files, any host
  studio/        Vite + React + Three.js       -> the 3D editor
  planviewer/    Hotspot editor + exporter     -> self-contained HTML output
services/
  api/           Fastify — auth, orgs, scenes, credits, render jobs
  render-worker/ Headless Blender Cycles script
  floorplan-ai/  FastAPI symbol detection
packages/
  brand/         Brand tokens + plan/credit model (single source of truth)
```

## Running it

Everything runs locally with no cloud account and no Docker.

```bash
npm install

npm run dev:api      # http://localhost:8787
npm run dev:web      # http://localhost:4321
npm run dev:studio   # http://localhost:5173
npm run dev:plan     # http://localhost:5174
```

Floor-plan detection is a separate Python service:

```bash
cd services/floorplan-ai
python -m venv .venv && .venv/Scripts/activate   # Windows
pip install -r requirements.txt
uvicorn main:app --port 8090
```

The optional render/design vision pass is configured only on the Python
service. It supports the existing NVIDIA-compatible endpoint, or OpenAI:

```bash
# Preferred for an OpenAI deployment; never put this in browser code.
set OPENAI_API_KEY=your_server_secret
set FLOORPLAN_AI_PROVIDER=openai
# Optional model override; the default is gpt-4.1-mini.
set OPENAI_VISION_MODEL=gpt-4.1-mini
```

With `FLOORPLAN_AI_PROVIDER=auto`, an `OPENAI_API_KEY` is used when no NVIDIA
key is present. The reader remains fail-open when no key is configured, and
CAD measurements and geometry continue to come from the deterministic engine.
For a bounded first evaluation, additionally set
`FLOORPLAN_AI_MAX_PROVIDER_CALLS=3`,
`FLOORPLAN_AI_MAX_OUTPUT_TOKENS=1200`, and `ADJUDICATE_MAX_CROPS=1`. The health
response reports non-secret call/token usage. `evaluate_openai.py` applies
those limits automatically and refuses to accept a key on its command line.

Copy `.env.example` to `.env` first if you want to change any defaults. You do
not have to — every value has a working development default.

### Renders

`RENDER_MODE=local` (the default) spawns Blender on your own machine. Point
`BLENDER_PATH` at your install and renders cost you nothing but electricity.

`RENDER_MODE=remote` sends jobs to a GPU worker pool. **That is the mode that
bills per second.** Read [`docs/costs.md`](docs/costs.md) before switching.

## Rebranding

Edit [`packages/brand/brand.config.mjs`](packages/brand/brand.config.mjs). Name,
domains, colours and type all flow from that one file into every app.

## Session and credit policy

Sessions expire after 12 idle hours or 30 absolute days. Queueable work holds
its credits before submission; non-queueable work is rejected when the account
does not have enough credits.
