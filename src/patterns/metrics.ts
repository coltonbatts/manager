// Deterministic pattern metrics. No LLM here: just counting, with sample sizes
// attached to everything so the interpretation layer can't over-claim.

import type { DatabaseSync } from '../fs/guard.ts';
import type { ProjectView } from '../store.ts';
import { getProfile } from '../understand/profile.ts';
import { localDate } from '../util.ts';

const DAY = 86_400_000;
const QUIET_DAYS = 30; // no activity for this long = "gone quiet"

export interface ProjectHistory {
  id: string;
  name: string;
  days: string[]; // sorted unique active dates: commit days ∪ file-modified days
  commitDays: string[]; // commit days only
  commits: number;
  source: 'git' | 'files';
  shipDates: string[]; // ship evidence: tags, launch-like commits, manual marks
  stage?: string;
  closeness?: string;
}

export interface Patterns {
  generatedFor: string; // today
  coverage: {
    projects: number; gitProjects: number; fileProjects: number; foreignExcluded: number; noHistory: number;
    commits: number; firstDate: string | null; snapshotDays: number;
  };
  breadth: { weeks: { week: string; projects: number }[]; activeWeeks: number; medianPerActiveWeek: number; recent4: number; prior: number };
  startsVsFinishes: { months: { month: string; started: number; shipped: number }[]; started: number; shipped: number };
  lifespan: { n: number; medianSpanDays: number; medianActiveDays: number; buckets: Record<string, number> };
  oneBurst: { n: number; count: number };
  attention: { windowDays: number; projects: { name: string; activeDays: number; commits: number }[]; top1Share: number; top3Share: number };
  stallPoint: { quiet: number; profiled: number; byStage: Record<string, number>; byCloseness: Record<string, number>; quietWithShipEvidence: number };
  revivals: { gaps: number; revived: number };
  weekdays: { counts: number[]; n: number }; // Mon..Sun, project-days
}

function weekKey(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  const dow = (d.getDay() + 6) % 7; // Mon = 0
  return localDate(d.getTime() - dow * DAY);
}

const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime()) / DAY);

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function loadHistories(db: DatabaseSync, projects: ProjectView[]): { histories: ProjectHistory[]; foreign: number; noHistory: number } {
  const rows = db.prepare('SELECT project_id, date, source, count FROM activity_days').all() as
    { project_id: string; date: string; source: string; count: number }[];
  const signals = db.prepare('SELECT project_id, date FROM signals').all() as { project_id: string; date: string }[];
  const marks = db.prepare("SELECT project_id, date FROM events WHERE type = 'shipped'").all() as { project_id: string; date: string }[];

  const histories: ProjectHistory[] = [];
  let foreign = 0;
  let noHistory = 0;
  for (const p of projects) {
    if (p.facts.git?.foreign) { foreign++; continue; }
    const source = p.facts.git && p.facts.git.commitCount > 0 ? 'git' : 'files';
    const mine = rows.filter((r) => r.project_id === p.id);
    if (!mine.length) { noHistory++; continue; }
    const gitRows = mine.filter((r) => r.source === 'git');
    const prof = getProfile(db, p)?.profile;
    const ship = [...signals, ...marks].filter((s) => s.project_id === p.id).map((s) => s.date);
    histories.push({
      id: p.id,
      name: p.name,
      days: [...new Set(mine.map((r) => r.date))].sort(),
      commitDays: gitRows.map((r) => r.date).sort(),
      commits: gitRows.reduce((a, r) => a + r.count, 0),
      source,
      shipDates: [...new Set(ship)].sort(),
      stage: prof?.stage,
      closeness: prof?.closeness,
    });
  }
  return { histories, foreign, noHistory };
}

export function computePatterns(histories: ProjectHistory[], meta: { foreign: number; noHistory: number; snapshotDays: number }, today = localDate()): Patterns {
  const allDays = histories.flatMap((h) => h.days).sort();

  // Breadth: distinct projects touched per week, last 26 weeks.
  const thisWeek = weekKey(today);
  const weeks: { week: string; projects: number }[] = [];
  for (let i = 25; i >= 0; i--) {
    const wk = localDate(new Date(`${thisWeek}T12:00:00`).getTime() - i * 7 * DAY);
    const n = histories.filter((h) => h.days.some((d) => weekKey(d) === wk)).length;
    weeks.push({ week: wk, projects: n });
  }
  const active = weeks.filter((w) => w.projects > 0);
  const avg = (ws: typeof weeks) => (ws.length ? ws.reduce((a, w) => a + w.projects, 0) / ws.length : 0);

  // Starts vs finishes, last 12 months.
  const months: { month: string; started: number; shipped: number }[] = [];
  const t = new Date(`${today}T12:00:00`);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(t.getFullYear(), t.getMonth() - i, 1);
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({
      month: m,
      started: histories.filter((h) => h.days[0].startsWith(m)).length,
      shipped: histories.filter((h) => h.shipDates.some((s) => s.startsWith(m))).length,
    });
  }

  // Lifespan of projects that have gone quiet.
  const quiet = histories.filter((h) => daysBetween(h.days[h.days.length - 1], today) > QUIET_DAYS);
  const spans = quiet.map((h) => daysBetween(h.days[0], h.days[h.days.length - 1]) + 1);
  const buckets: Record<string, number> = { '1 day': 0, '2–7 days': 0, '8–30 days': 0, '31–90 days': 0, '90+ days': 0 };
  for (const s of spans) {
    buckets[s <= 1 ? '1 day' : s <= 7 ? '2–7 days' : s <= 30 ? '8–30 days' : s <= 90 ? '31–90 days' : '90+ days']++;
  }

  // Attention over the last 90 days.
  const since = localDate(new Date(`${today}T12:00:00`).getTime() - 90 * DAY);
  const recent = histories
    .map((h) => ({ name: h.name, activeDays: h.days.filter((d) => d >= since).length, commits: h.commits }))
    .filter((r) => r.activeDays > 0)
    .sort((a, b) => b.activeDays - a.activeDays);
  const totalRecent = recent.reduce((a, r) => a + r.activeDays, 0) || 1;

  // Where quiet projects stopped, per their profiles.
  const byStage: Record<string, number> = {};
  const byCloseness: Record<string, number> = {};
  let profiled = 0;
  for (const h of quiet) {
    if (!h.stage) continue;
    profiled++;
    byStage[h.stage] = (byStage[h.stage] ?? 0) + 1;
    if (h.closeness) byCloseness[h.closeness] = (byCloseness[h.closeness] ?? 0) + 1;
  }

  // Revivals: a 30+ day gap followed by more activity.
  let gaps = 0;
  let revived = 0;
  for (const h of histories) {
    for (let i = 1; i < h.days.length; i++) if (daysBetween(h.days[i - 1], h.days[i]) > QUIET_DAYS) { gaps++; revived++; }
    if (daysBetween(h.days[h.days.length - 1], today) > QUIET_DAYS) gaps++;
  }

  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  for (const h of histories) for (const d of h.commitDays) weekdays[(new Date(`${d}T12:00:00`).getDay() + 6) % 7]++;

  return {
    generatedFor: today,
    coverage: {
      projects: histories.length,
      gitProjects: histories.filter((h) => h.source === 'git').length,
      fileProjects: histories.filter((h) => h.source === 'files').length,
      foreignExcluded: meta.foreign,
      noHistory: meta.noHistory,
      commits: histories.reduce((a, h) => a + h.commits, 0),
      firstDate: allDays[0] ?? null,
      snapshotDays: meta.snapshotDays,
    },
    breadth: {
      weeks,
      activeWeeks: active.length,
      medianPerActiveWeek: median(active.map((w) => w.projects)),
      recent4: Number(avg(weeks.slice(-4)).toFixed(1)),
      prior: Number(avg(weeks.slice(0, -4)).toFixed(1)),
    },
    startsVsFinishes: {
      months,
      started: months.reduce((a, m) => a + m.started, 0),
      shipped: months.reduce((a, m) => a + m.shipped, 0),
    },
    lifespan: { n: quiet.length, medianSpanDays: median(spans), medianActiveDays: median(quiet.map((h) => h.days.length)), buckets },
    oneBurst: { n: histories.length, count: histories.filter((h) => h.days.length <= 3).length },
    attention: {
      windowDays: 90,
      projects: recent.slice(0, 8),
      top1Share: Number(((recent[0]?.activeDays ?? 0) / totalRecent).toFixed(2)),
      top3Share: Number((recent.slice(0, 3).reduce((a, r) => a + r.activeDays, 0) / totalRecent).toFixed(2)),
    },
    stallPoint: { quiet: quiet.length, profiled, byStage, byCloseness, quietWithShipEvidence: quiet.filter((h) => h.shipDates.length).length },
    revivals: { gaps, revived },
    weekdays: { counts: weekdays, n: weekdays.reduce((a, b) => a + b, 0) },
  };
}

export function snapshotDays(db: DatabaseSync): number {
  return (db.prepare('SELECT count(DISTINCT date) AS n FROM snapshots').get() as { n: number }).n;
}
