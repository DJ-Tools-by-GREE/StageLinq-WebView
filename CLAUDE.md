# CLAUDE.md — StageLinq WebView

Read **[AGENTS.md](AGENTS.md)** first — it is the canonical, tool-neutral project guide for this repo (shared with Codex and any other tool).

## Memory policy
Durable project state lives **in the repo**, never in Claude native memory:
- project state, architectural decisions + rationale, hardware quirks/workarounds, in-progress work and blockers → **`memory.md`** at the repo root — update it immediately as described in AGENTS.md.

Do not write this repo's durable knowledge to Claude's native memory store; `memory.md` (and the other repo docs) are the single source of truth, readable by any agent.
