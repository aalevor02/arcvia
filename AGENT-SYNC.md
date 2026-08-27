# Arcvia Claude/Codex sync

This file is the durable coordination contract. `COORDINATION.md` in the
canonical worktree is the live append-only board when present.

## Protocol

1. Before edits, record agent, time, objective, worktree/branch, and claimed
   paths.
2. Do not overlap an active claim. Use an isolated worktree for concurrent work.
3. Treat the working tree and Git history as the source of truth. A pending note
   is evidence to investigate, not proof that code is missing.
4. Commit only claimed paths. Never use a bare commit in a shared dirty tree.
5. On completion, record changed files, commit, tests, risks, and the next
   actionable item. Preserve evidence-blocked refusals rather than inventing a
   threshold or weakening a gate.

## Completed claim - Codex - 2026-08-28

- Branch/worktree: `codex/finish-arcvia-20260828` at
  `C:\Users\aalev\Arcvia-canonical-worktree`
- Claimed paths: `apps/studio/src/lib/renderClient.ts`,
  `services/api/test/bake.mjs`, three web cleanup files, `CLAUDE.md`, and
  `AGENT-SYNC.md`.
- Objective: make render cancellation send a valid empty POST, surface failed
  cancellation, add its regression assertion, and establish durable Claude/Codex
  coordination.
- Base: Claude commit `6f830b3`.
- Explicitly untouched: canonical uncommitted `docs/PENDING-ARCVIA.md`, IFC
  inputs, `sample-bim/`, and all reconstruction/compliance paths.
- Code commit after rebasing onto Claude `4982268`: `65125d0`.
- Validation: Studio 867 assertions and production build; isolated bake 31/31;
  codecheck 37/37; compliance 50/50; site-container 48/48; full harness types
  5, Python 30, BIM 1, and builds 4 all green; web linkcheck 16/16 and web
  diagnostics at 0 errors with one intentional deprecated-copy fallback hint.
- The full shared-port API run passed 28 of 29 files; its bake process could not
  read the other worktree's database. The same bake file passed 31/31 when API,
  `API_BASE`, and `DB_PATH` were isolated together. Canonical application data
  was not used for test writes.
- Visual-only panorama/post-edit/stairs checks remain blocked by Windows browser
  startup error 1344. No source or credentials were sent to an external model.

## Recovered backlog audit

- Compliance provenance was interrupted, then completed by Claude in `e18d4df`.
- IFC-space import was completed by Claude in `90d0fe1`.
- Site-as-buildings is already implemented in `solve/site.py`, wired through
  `cli.py`, verified by `test_site.py`, and documented as done. Any later note
  calling it unbuilt is stale.
- Window precision remains evidence-blocked because the real windows were never
  enumerated. `ADJUDICATE_WINDOW_PASSES` stays at 1.
- Furniture-based wall dropping remains deliberately disabled because measured
  classes overlap and the trial destroyed a real recall-control wall.
