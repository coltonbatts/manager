// Token usage from local Claude Code transcripts (~/.claude/projects/**/*.jsonl).
// Only numbers are extracted: date, project folder, model, token counts. Message
// content is never stored and never sent anywhere. Parsing is incremental per file.

import { basename } from 'node:path';
import type { DatabaseSync } from '../fs/guard.ts';
import { findFiles, readLines } from '../fs/read.ts';
import { localDate } from '../util.ts';

export interface DayUsage {
  date: string;
  project: string;
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Line {
  type?: string;
  timestamp?: string;
  cwd?: string;
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
}

/** Aggregates one transcript. Streaming writes several lines per response, so we count each message id once (last line wins). */
export async function parseTranscript(path: string): Promise<DayUsage[]> {
  const byMessage = new Map<string, { date: string; project: string; model: string; u: NonNullable<NonNullable<Line['message']>['usage']> }>();
  for await (const raw of readLines(path)) {
    if (!raw.includes('"usage"')) continue;
    let d: Line;
    try { d = JSON.parse(raw) as Line; } catch { continue; }
    const u = d.message?.usage;
    if (d.type !== 'assistant' || !u || !d.timestamp) continue;
    const model = d.message?.model ?? 'unknown';
    if (model === '<synthetic>') continue;
    const key = d.message?.id ?? d.requestId ?? `${d.timestamp}`;
    byMessage.set(key, { date: localDate(Date.parse(d.timestamp)), project: d.cwd ? basename(d.cwd) : 'unknown', model, u });
  }
  const days = new Map<string, DayUsage>();
  for (const { date, project, model, u } of byMessage.values()) {
    const k = `${date}\0${project}\0${model}`;
    const cur = days.get(k) ?? { date, project, model, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    cur.requests++;
    cur.input += u.input_tokens ?? 0;
    cur.output += u.output_tokens ?? 0;
    cur.cacheRead += u.cache_read_input_tokens ?? 0;
    cur.cacheWrite += u.cache_creation_input_tokens ?? 0;
    days.set(k, cur);
  }
  return [...days.values()];
}

/** Re-parses only transcripts whose size or mtime changed since last sync. */
export async function syncTranscripts(db: DatabaseSync, dir: string): Promise<{ files: number; parsed: number }> {
  const files = findFiles(dir, '.jsonl');
  const known = new Map((db.prepare('SELECT path, size, mtime FROM usage_files').all() as { path: string; size: number; mtime: number }[])
    .map((r) => [r.path, r]));
  const del = db.prepare('DELETE FROM usage_file_days WHERE path = ?');
  const ins = db.prepare(`INSERT INTO usage_file_days (path, date, project, model, requests, input, output, cache_read, cache_write)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const mark = db.prepare('INSERT OR REPLACE INTO usage_files (path, size, mtime) VALUES (?, ?, ?)');
  let parsed = 0;
  for (const f of files) {
    const k = known.get(f.path);
    if (k && k.size === f.size && k.mtime === Math.floor(f.mtimeMs)) continue;
    let rows: DayUsage[];
    try { rows = await parseTranscript(f.path); } catch { continue; }
    db.exec('BEGIN');
    try {
      del.run(f.path);
      for (const r of rows) ins.run(f.path, r.date, r.project, r.model, r.requests, r.input, r.output, r.cacheRead, r.cacheWrite);
      mark.run(f.path, f.size, Math.floor(f.mtimeMs));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    parsed++;
  }
  return { files: files.length, parsed };
}

export interface UsageTotals { requests: number; output: number; input: number; cacheRead: number; cacheWrite: number }

export function usageByDay(db: DatabaseSync, days: number, now = Date.now()): ({ date: string } & UsageTotals)[] {
  const out: ({ date: string } & UsageTotals)[] = [];
  const rows = new Map((db.prepare(`
    SELECT date, sum(requests) AS requests, sum(output) AS output, sum(input) AS input, sum(cache_read) AS cacheRead, sum(cache_write) AS cacheWrite
    FROM usage_file_days WHERE date >= ? GROUP BY date`).all(localDate(now - (days - 1) * 86_400_000)) as unknown as ({ date: string } & UsageTotals)[])
    .map((r) => [r.date, r]));
  for (let i = days - 1; i >= 0; i--) {
    const date = localDate(now - i * 86_400_000);
    out.push(rows.get(date) ?? { date, requests: 0, output: 0, input: 0, cacheRead: 0, cacheWrite: 0 });
  }
  return out;
}

export function usageByProject(db: DatabaseSync, days: number, now = Date.now()): { project: string; requests: number; output: number }[] {
  return db.prepare(`
    SELECT project, sum(requests) AS requests, sum(output) AS output FROM usage_file_days
    WHERE date >= ? GROUP BY project ORDER BY requests DESC LIMIT 8`).all(localDate(now - (days - 1) * 86_400_000)) as
    { project: string; requests: number; output: number }[];
}

export function usageByModel(db: DatabaseSync, days: number, now = Date.now()): { model: string; requests: number }[] {
  return db.prepare(`
    SELECT model, sum(requests) AS requests FROM usage_file_days
    WHERE date >= ? GROUP BY model ORDER BY requests DESC`).all(localDate(now - (days - 1) * 86_400_000)) as { model: string; requests: number }[];
}
