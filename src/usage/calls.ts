// Manager's own LLM calls: what each task cost, by model. The interactive-session
// numbers come from transcripts; these calls use --no-session-persistence, so
// this table is the only place they show up.

import type { DatabaseSync } from '../fs/guard.ts';
import type { LLMCallRecord } from '../llm/provider.ts';

export function recordCall(db: DatabaseSync, c: LLMCallRecord): void {
  db.prepare(`INSERT INTO llm_calls (at, task, model, ok, input, output, cache_read, cache_write, cost_usd, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(c.at, c.task, c.model, c.ok ? 1 : 0, c.input, c.output, c.cacheRead, c.cacheWrite, c.costUsd, c.durationMs);
}

export interface TaskUsage {
  task: string;
  model: string;
  calls: number;
  failed: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  avgMs: number;
}

/** Calls since `since` (ms), one row per task and model, costliest first. */
export function callsByTask(db: DatabaseSync, since: number): TaskUsage[] {
  return db.prepare(`
    SELECT task, model, count(*) AS calls, sum(1 - ok) AS failed,
           sum(input) AS input, sum(output) AS output, sum(cache_read) AS cacheRead, sum(cache_write) AS cacheWrite,
           sum(cost_usd) AS costUsd, cast(avg(duration_ms) AS INTEGER) AS avgMs
    FROM llm_calls WHERE at >= ? GROUP BY task, model ORDER BY costUsd DESC`).all(since) as unknown as TaskUsage[];
}

export const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
