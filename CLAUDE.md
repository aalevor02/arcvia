# Arcvia agent coordination

Before changing Arcvia, read `AGENT-SYNC.md`, `COORDINATION.md` when it exists in
the canonical worktree, and `docs/PENDING-ARCVIA.md`. The pending document is a
historical ledger, not an unquestioned backlog: verify every claimed gap against
the current tree and tests before implementing it.

Codex and Claude may work at the same time. Use separate Git worktrees or
non-overlapping path claims. Never reset, overwrite, stage, or commit another
agent's files. Record the commit, exact files, validation, blockers, and next
action in the shared ledger after each completed unit.

The canonical repository is `A:\Web\Arcvia`. A copied tree without its Git
history is not authoritative.
