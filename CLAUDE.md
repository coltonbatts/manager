# Manager

A local studio manager for Colton (Alternative Design). It watches the project folders under `~/Documents` and `~/dev`, keeps snapshots over time, and helps Colton see his own work clearly: studio manager + scientist + a bit of a therapist.

## Hard rules (non-negotiable)

1. **Strictly read-only outside `./data`.** Manager may read the watched roots but must never write, modify, move, or delete anything outside `~/MANAGER/data`.
   - `src/fs/guard.ts` is the **only** module allowed to import fs write APIs or open a database. Every write goes through `assertWritable`, which resolves symlinks and `..` and refuses anything not strictly inside `data/`.
   - `test/guard.test.ts` enforces this, and also greps `src/` for write APIs outside the guard. Don't weaken that check. Route new writes through the guard.
   - Git access goes through `src/git.ts`: allowlisted read-only subcommands, `GIT_OPTIONAL_LOCKS=0`, fsmonitor and untrackedCache off. Plain `git status` can rewrite another repo's index or create lock files. **When you (Claude) inspect watched repos by hand, also prefix git with `GIT_OPTIONAL_LOCKS=0`.**
   - Tests must never call destructive functions on real paths, even ones the guard should refuse. Use nonexistent targets, or `assertWritable` (no side effects).
2. **Local-first.** All state lives in `./data` (SQLite + markdown/JSON). No telemetry, no cloud services, no network calls except the local `claude` CLI.
3. **Intelligence comes from `claude -p --output-format json`**, behind the `LLMProvider` interface (slice 2). No API keys. The LLM gets a digest Manager builds, never raw file access. Run it with tools disabled, from inside `data/tmp`.
4. **Ignore junk and secrets.** `src/fs/read.ts` owns the rules: `JUNK_DIRS`, `MEDIA_HEAVY_DIRS`, venv detection, `isSecretPath`. Secret-like files (`.env*`, keys, certs, credentials, `.ssh`, …) are never listed, never read (`readTextSafe` throws), and never sent to the LLM. Git repos use `git ls-files -co --exclude-standard`. Other folders use `src/fs/gitignore.ts`.
5. **Simple over clever.** Smallest high-ROI solution. Ask before adding a dependency.

## Stack

- Node ≥ 22.18 runs `.ts` directly (type stripping), so there's **no build step**. Use only erasable syntax: no enums, no namespaces, no parameter properties, `import type` for types, and `.ts` extensions in imports.
- `node:sqlite` (built in), `node:test` (built in). Dev deps are only `typescript` and `@types/node`.
- The dashboard is HTML rendered by a `node:http` server bound to 127.0.0.1, plus one CSS file. No React, no bundler.

## Layout

```
bin/manager.js          CLI entry (`npm link` to get `manager` on PATH)
manager.config.json     roots, per-root excludes, include/exclude paths, depth, skipDirs
src/paths.ts            ROOT, DATA_DIR
src/fs/guard.ts         the only writer
src/fs/read.ts          read helpers, junk/secret rules, listFiles
src/fs/gitignore.ts     .gitignore matcher for non-git folders
src/git.ts              read-only git wrapper
src/config.ts           config loading
src/db.ts               data/manager.db + migrations (append to MIGRATIONS, never edit old ones)
src/scan/discover.ts    roots → candidate projects
src/scan/facts.ts       cheap per-project facts (no LLM)
src/scan/scan.ts        runScan: discover → facts → snapshot
src/store.ts            read-side queries (CLI + dashboard)
src/util.ts             pool() concurrency helper
src/llm/provider.ts     LLMProvider interface (swap point)
src/llm/claude-cli.ts   claude -p implementation (no tools, no MCP, stdin prompt, timeout)
src/understand/digest.ts   per-project text the LLM sees (facts, commits, tree, README excerpts)
src/understand/redact.ts   credential scrubber applied to every digest
src/understand/profile.ts  per-project profiles, cached by snapshot fingerprint → data/profiles/*.md
src/understand/portfolio.ts portfolio synthesis, cached by input hash → data/reports/*.md
src/patterns/metrics.ts    deterministic metrics from activity_days/signals/events (every number carries its n)
src/patterns/hypotheses.ts LLM hypotheses over the metrics, with evidence, alternative and falsifier
src/journal/journal.ts     data/journal.db (entries, checkins). Separate from manager.db
src/journal/correlate.ts   energy/mood vs. activity (silent below MIN_DAYS scored days; |r| ≥ 0.3 only)
src/journal/checkin.ts     check-in context, LLM questions, rule-based fallback questions
src/web/server.ts       node:http on 127.0.0.1; Host/Origin checks; CSP; only write = journal entry POST
src/web/views.ts        server-rendered pages: / (wall), /p/:id, /patterns, /journal
src/web/html.ts         escaping html`` tag (interpolations escaped unless raw())
src/web/style.css       the whole design: paper/ink tokens, one accent, light + dark
src/web/app.js          the only client script: refreshes the masthead usage gauge from /api/usage
src/web/usage-views.ts  usage gauges (masthead on every page via <!--usage--> placeholder) + Journal "Claude" section
src/usage/limits.ts     plan limits from `claude -p /usage` (local command, no model call); parsed + stored in usage_limits
src/usage/transcripts.ts token counts from ~/.claude/projects/**/*.jsonl, incremental per file; numbers only
src/commands/*.ts       CLI commands
test/                   node:test; fixtures go in data/test-tmp via the guard
```

## Concepts

- **Project**: a git repo root or a folder with a code manifest. Containers (folders with projects below them) are expanded, and their non-code children with content become projects too. Any other non-empty top-level folder is also a project (creative work, notes). Ids are stable slugs, parent-qualified on collision.
- **Snapshot**: one row per project per local day (the latest scan that day wins). `facts_json` holds the full `Facts`.
- **lastActivityAt**: for a clean git repo, the last commit time. Otherwise the max of last commit and newest file mtime (checkouts make mtimes unreliable in clean repos).
- **State**: active ≤7d, warm ≤30d, cooling ≤90d, dormant >90d.
- **Identity**: git stats count only commits whose author matches `identities` in the config. Repos with history but none of it yours are `foreign` (clones) and left out of pattern stats.
- **activity_days**: `git` rows are recomputed from full history every scan. `files` rows (mtime per day) only ever grow, since mtimes move forward. An active day is the union of both.
- **Claude usage**: `manager serve` refreshes plan limits and transcript totals every `usage.refreshMinutes`. Gauges show fill = % used and a thin mark = % of the window elapsed (5h session, 7d week). Transcripts are a second read root (`usage.transcriptsDir`). Only date/project/model/token counts are extracted, never message content, and none of it goes to the LLM.
- **Ship evidence**: release tags, launch-like commit subjects (`SHIP_RE` in facts.ts), and manual `manager mark` events.
- Journal data lives in `data/journal.db`, separate from project data. Journal **text** is sent to the LLM only if `journal.shareTextWithLLM` is true (default false). Check-ins otherwise see only scores and activity.
- Never write test or demo rows into the real `data/journal.db` or `data/manager.db`. Use `TMP` databases in tests.

## Conventions

- Commands: `npm test`, `npm run typecheck`, `./bin/manager.js <cmd>`. Preview the dashboard with `.claude/launch.json` (`manager`, port 4747).
- Tests never call the real LLM. Use a fake `LLMProvider`. Test fixtures go in `TMP` from `test/helpers.ts` (one dir per test process). Scan fixtures with `scanFixture`, which overrides discovery's self-exclusion.
- `claude -p` hangs (it retries silently) when the CLI's OAuth login has expired. The provider times out with a hint to `/login`.
- Terminal tone is quiet: dim and bold, no color, no emoji.
- Scientist / therapist output must state sample sizes and uncertainty, and never over-claim from thin data.
- Commit after each slice.

## Build slices

1. ✅ config + guard + scan + status (+ basic `project`)
2. ✅ per-project LLM profiles via `claude -p`, cached by fingerprint; `report`
3. ✅ git-history backfill + snapshots over time + `patterns` + `mark`
4. ✅ `checkin` + `log` (journal)
5. ✅ local dashboard (`serve`)

## Dashboard design

A quiet studio wall, not an admin panel. Typography-led (Iowan Old Style / Charter serif, system mono for data), paper-and-ink palette with one muted vermilion accent reserved for "recent" and "needs attention". No gradients, no web fonts or CDNs (local-first), no client JS. Motion is one staggered fade-in, disabled under reduced-motion. Dormant projects appear as a colophon list, not cards. The dashboard never calls the LLM; it shows the latest cached reports.
