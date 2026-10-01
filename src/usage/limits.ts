// Plan limits from `claude -p "/usage"`: a local slash command, no model call, no cost.
// We parse lines like:
//   Current session: 45% used · resets Oct 1 at 5:39pm (America/Chicago)
//   Current week (all models): 29% used · resets Oct 4 at 11:59am (America/Chicago)

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { DatabaseSync } from '../fs/guard.ts';
import { ensureDir } from '../fs/guard.ts';
import { DATA_DIR } from '../paths.ts';

export interface Limit {
  label: string; // "session", "week (all models)", …
  percent: number;
  resetsText: string | null; // as printed, minus the timezone
  resetsAt: number | null; // ms, parsed in local time
  windowMs: number | null; // 5h for sessions, 7d for weeks
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const HOUR = 3_600_000;

/** "Oct 1 at 5:39pm" or "5:39pm" → ms (local time). Picks the next occurrence on or after `now`. */
export function parseReset(text: string, now = Date.now()): number | null {
  const m = /^(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i.exec(text.trim());
  if (!m) return null;
  const [, mon, day, year, hh, mm, ap] = m;
  let hour = Number(hh) % 12;
  if (ap.toLowerCase() === 'pm') hour += 12;
  const base = new Date(now);
  const d = new Date(
    year ? Number(year) : base.getFullYear(),
    mon ? MONTHS.indexOf(mon.toLowerCase()) : base.getMonth(),
    day ? Number(day) : base.getDate(),
    hour, Number(mm ?? 0), 0, 0,
  );
  if (mon && MONTHS.indexOf(mon.toLowerCase()) < 0) return null;
  // A date without a year that has already passed by months means next year (e.g. Jan from December).
  if (!year && d.getTime() < now - 30 * 24 * HOUR) d.setFullYear(d.getFullYear() + 1);
  if (!mon && d.getTime() < now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function parseLimits(text: string, now = Date.now()): Limit[] {
  const out: Limit[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*Current\s+(.+?):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*[·•-]\s*resets\s+(.+?))?\s*$/i.exec(line);
    if (!m) continue;
    const label = m[1].trim().toLowerCase();
    const resetsText = m[3] ? m[3].replace(/\s*\([^)]*\)\s*$/, '').trim() : null;
    out.push({
      label,
      percent: Number(m[2]),
      resetsText,
      resetsAt: resetsText ? parseReset(resetsText, now) : null,
      windowMs: label.startsWith('session') ? 5 * HOUR : label.startsWith('week') ? 7 * 24 * HOUR : null,
    });
  }
  return out;
}

/** Fraction of the window already elapsed, if we know both the window and its reset. */
export function elapsedFraction(l: Limit, now = Date.now()): number | null {
  if (!l.resetsAt || !l.windowMs) return null;
  const f = 1 - (l.resetsAt - now) / l.windowMs;
  return Math.min(1, Math.max(0, f));
}

export function fetchLimitsText(command: string, timeoutSeconds = 45): Promise<string> {
  const cwd = ensureDir(join(DATA_DIR, 'tmp'));
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return new Promise((resolve, reject) => {
    const child = spawn(command, ['-p', '/usage', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence'],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('claude /usage timed out')); }, timeoutSeconds * 1000);
    child.stdout.on('data', (d: Buffer) => { stdout += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const env = JSON.parse(stdout) as { is_error?: boolean; result?: string };
        if (env.is_error) reject(new Error(String(env.result).slice(0, 200)));
        else resolve(String(env.result ?? ''));
      } catch {
        reject(new Error('claude /usage returned no JSON'));
      }
    });
  });
}

export function recordLimits(db: DatabaseSync, limits: Limit[], at = Date.now()): void {
  const ins = db.prepare('INSERT INTO usage_limits (at, label, percent, resets_text, resets_at) VALUES (?, ?, ?, ?, ?)');
  for (const l of limits) ins.run(at, l.label, l.percent, l.resetsText, l.resetsAt);
}

export async function refreshLimits(db: DatabaseSync, command: string): Promise<Limit[]> {
  const limits = parseLimits(await fetchLimitsText(command));
  if (!limits.length) throw new Error('could not find usage lines in claude /usage output');
  recordLimits(db, limits);
  return limits;
}

export function latestLimits(db: DatabaseSync): { at: number; limits: Limit[] } | null {
  const last = db.prepare('SELECT max(at) AS at FROM usage_limits').get() as { at: number | null };
  if (!last.at) return null;
  const rows = db.prepare('SELECT label, percent, resets_text, resets_at FROM usage_limits WHERE at = ? ORDER BY rowid').all(last.at) as
    { label: string; percent: number; resets_text: string | null; resets_at: number | null }[];
  return {
    at: last.at,
    limits: rows.map((r) => ({
      label: r.label, percent: r.percent, resetsText: r.resets_text, resetsAt: r.resets_at,
      windowMs: r.label.startsWith('session') ? 5 * HOUR : r.label.startsWith('week') ? 7 * 24 * HOUR : null,
    })),
  };
}
