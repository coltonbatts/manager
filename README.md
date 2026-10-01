# Manager

A quiet, local studio manager for Alternative Design. It watches the project folders under `~/Documents` and `~/dev` (strictly read-only), keeps dated snapshots, and helps you see your own work clearly.

```
npm install          # dev deps only: typescript, @types/node
npm link             # optional: puts `manager` on your PATH
```

Requires Node ≥ 22.18 (runs TypeScript directly, uses built-in SQLite) and, for the intelligence features, a logged-in `claude` CLI.

## Commands

| | |
|---|---|
| `manager scan` | discover projects and record today's snapshot (fast, no LLM) |
| `manager status [--all]` | portfolio at a glance |
| `manager project <name> [--refresh\|--offline]` | one project, with its LLM profile |
| `manager report [--force]` | profile changed projects, then a portfolio synthesis |
| `manager patterns [--no-llm\|--force]` | metrics from your history, plus hypotheses with evidence |
| `manager mark <project> shipped\|paused\|abandoned\|active` | record a lifecycle event by hand |
| `manager log "text" [energy 1–5] [--mood 1–5]` | journal entry. `manager log` alone shows entries |
| `manager checkin` | 2–4 questions grounded in what the data shows |
| `manager serve [--port 4747]` | local dashboard on 127.0.0.1 |

Configure roots, excludes, your git identities, models, and journal privacy in `manager.config.json`. All state lives in `./data`. See `CLAUDE.md` for the rules and architecture.
