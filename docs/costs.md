# Running costs

Written because cost is the reason this rebuild exists.

## The shape of the problem

Of the six components in this system, **one** is expensive. Everything else is
rounding error. Getting this wrong — treating the whole platform as uniformly
costly — leads to cutting the cheap parts and keeping the expensive one.

| Component | Cost driver | Rough monthly |
|---|---|---|
| `apps/web` (Astro static) | CDN egress on a few MB | ~$0–5 |
| `apps/studio` (static SPA) | CDN egress | ~$0–5 |
| `apps/planviewer` | Static files | ~$0 |
| `services/api` | One small always-on VM | ~$5–20 |
| `services/floorplan-ai` | One small CPU VM | ~$5–20 |
| Object storage | Models, HDRIs, renders | ~$5–30 |
| **`services/render-worker`** | **GPU seconds** | **$0 → unbounded** |

The first six add up to somewhere around $20–80/month at small scale. The
seventh is the entire question.

## Why the GPU line is dangerous

A GPU instance bills by wall-clock time, not by work done. An idle GPU box costs
exactly what a busy one costs. So the cost is driven by **how long instances are
alive**, not how many renders you serve.

Three failure modes, all of which cost real money:

1. **An always-on worker.** A GPU instance left running 24/7 bills ~720 hours a
   month whether it renders once or ten thousand times.
2. **Concurrency creep.** Raising `RENDER_CONCURRENCY` from 1 to 8 multiplies
   your worst-case burn by 8. It is one environment variable.
3. **A submit loop.** A bug that queues renders in a loop can spend a month's
   budget overnight, and nothing in AWS will stop it.

## What this codebase does about it

All in `services/api/src/lib/renderQueue.js`, all defaulting to safe:

```
RENDER_MODE=local          # your machine, not a billed GPU — the DEFAULT
RENDER_CONCURRENCY=1       # one job at a time
RENDER_TIMEOUT_MS=600000   # 10 min hard kill per job
RENDER_DAILY_CAP=500       # install-wide circuit breaker
```

Plus, at the application layer:

- Credits are charged **before** the job is queued, not after. Charging on
  completion lets a user with zero credits fill the queue and consume GPU time
  anyway.
- Cancelling a *queued* job refunds. Cancelling a *rendering* job does not —
  that GPU time is spent regardless.
- Failed jobs refund automatically. A crash on our side should not cost the
  user anything.

## The single highest-leverage setting

In `services/render-worker/render.py`:

```python
cycles.use_denoising = True
cycles.use_adaptive_sampling = True
```

Denoising lets a 32-sample render look like a far more expensive one. Without
it you need roughly an order of magnitude more samples for comparable output —
which is an order of magnitude more GPU time, for the same picture.

Adaptive sampling stops refining tiles that have already converged, so a flat
plastered wall does not get sampled as hard as a glass table.

Between them, these two lines are worth more than any infrastructure
optimisation you will make.

## How to run the worker cheaply

1. **Never leave it warm.** Start the instance from the queue, stop it when the
   queue drains. Renders are bursty; the machine should be too.
2. **Use spot / preemptible instances.** Renders are retryable by definition —
   the job spec is in the database, so an interrupted render just runs again.
   Spot is typically 60–90% cheaper.
3. **Render at the size you will actually display.** A 2560×1440 still that gets
   shown in a 400px card cost roughly 20× what it needed to.
4. **Bake once, not per view.** A lightmap bake is expensive precisely because
   it replaces per-frame lighting cost forever. One bake makes every subsequent
   walkthrough view free.

## When billing turns on

The plan model already meters everything. Before you charge, check that
`creditCost` in `packages/brand/plans.config.mjs` still reflects reality —
measure the actual GPU seconds per preset on your hardware and adjust. Selling
credits below cost is a good way to lose more money the more successful you get.
