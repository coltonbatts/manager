// Read-side queries shared by the CLI and (later) the web dashboard.

import type { DatabaseSync } from './fs/guard.ts';
import type { Facts } from './scan/facts.ts';
import { localDate } from './util.ts';

export type State = 'active' | 'warm' | 'cooling' | 'dormant' | 'unknown';

const DAY = 86_400_000;

export function stateOf(lastActivityAt: number | null, now = Date.now()): State {
  if (!lastActivityAt) return 'unknown';
  const days = (now - lastActivityAt) / DAY;
  if (days <= 7) return 'active';
  if (days <= 30) return 'warm';
  if (days <= 90) return 'cooling';
  return 'dormant';
}

export interface ProjectView {
  id: string;
  path: string;
  name: string;
  root: string;
  kind: string;
  firstSeen: number;
  snapshotDate: string;
  takenAt: number;
  facts: Facts;
  state: State;
}

interface Row {
  id: string; path: string; name: string; root: string; kind: string; first_seen: number;
  date: string; taken_at: number; facts_json: string;
}

const LATEST = `
  SELECT p.id, p.path, p.name, p.root, p.kind, p.first_seen, s.date, s.taken_at, s.facts_json
  FROM projects p
  JOIN snapshots s ON s.project_id = p.id
   AND s.date = (SELECT max(date) FROM snapshots WHERE project_id = p.id)
  WHERE p.missing = 0`;

function toView(r: Row, now: number): ProjectView {
  const facts = JSON.parse(r.facts_json) as Facts;
  return {
    id: r.id, path: r.path, name: r.name, root: r.root, kind: r.kind, firstSeen: r.first_seen,
    snapshotDate: r.date, takenAt: r.taken_at, facts, state: stateOf(facts.lastActivityAt, now),
  };
}

export function latestProjects(db: DatabaseSync, now = Date.now()): ProjectView[] {
  return (db.prepare(LATEST).all() as unknown as Row[])
    .map((r) => toView(r, now))
    .sort((a, b) => (b.facts.lastActivityAt ?? 0) - (a.facts.lastActivityAt ?? 0));
}

/** Finds a project by exact id, exact name, or unique substring. */
export function findProject(db: DatabaseSync, query: string): { match?: ProjectView; candidates: ProjectView[] } {
  const all = latestProjects(db);
  const q = query.toLowerCase();
  const exact = all.find((p) => p.id === q || p.name.toLowerCase() === q);
  if (exact) return { match: exact, candidates: [exact] };
  const partial = all.filter((p) => p.id.includes(q) || p.name.toLowerCase().includes(q));
  return { match: partial.length === 1 ? partial[0] : undefined, candidates: partial };
}

export function lastScan(db: DatabaseSync): { finishedAt: number; projectCount: number } | null {
  const r = db.prepare('SELECT finished_at, project_count FROM scans WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get() as
    { finished_at: number; project_count: number } | undefined;
  return r ? { finishedAt: r.finished_at, projectCount: r.project_count } : null;
}

/** Per local day: distinct projects touched (commits or file edits) and your commit count. */
export function dailyActivity(db: DatabaseSync): Map<string, { projects: number; commits: number }> {
  const rows = db.prepare(`
    SELECT date, count(DISTINCT project_id) AS projects, coalesce(sum(CASE WHEN source = 'git' THEN count END), 0) AS commits
    FROM activity_days GROUP BY date`).all() as { date: string; projects: number; commits: number }[];
  return new Map(rows.map((r) => [r.date, { projects: r.projects, commits: r.commits }]));
}

/** Active days per Monday-start week for the last `weeks` weeks, oldest first, keyed by project id. */
export function weeklyActivity(db: DatabaseSync, weeks: number, now = Date.now()): Map<string, number[]> {
  const DAYMS = 86_400_000;
  const today = new Date(now);
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7), 12).getTime();
  const start = monday - (weeks - 1) * 7 * DAYMS;
  const rows = db.prepare('SELECT DISTINCT project_id, date FROM activity_days WHERE date >= ?').all(localDate(start)) as
    { project_id: string; date: string }[];
  const out = new Map<string, number[]>();
  for (const r of rows) {
    const i = Math.floor((new Date(`${r.date}T12:00:00`).getTime() - start) / (7 * DAYMS));
    if (i < 0 || i >= weeks) continue;
    const arr = out.get(r.project_id) ?? new Array(weeks).fill(0);
    arr[i]++;
    out.set(r.project_id, arr);
  }
  return out;
}
