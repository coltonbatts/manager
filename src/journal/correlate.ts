// Energy/mood vs. project activity. Observations only: small n, no causation,
// and nothing is reported until there are enough scored days.

import type { Entry } from './journal.ts';
import { localDate } from '../util.ts';

export const MIN_DAYS = 10;

export interface DayActivity {
  projects: number; // distinct projects touched
  commits: number;
}

export interface Correlation {
  score: 'energy' | 'mood';
  measure: 'projects touched' | 'commits';
  lag: 'same day' | 'next day';
  r: number;
  n: number;
}

export interface CorrelationReport {
  scoredDays: { energy: number; mood: number };
  minDays: number;
  findings: Correlation[]; // only |r| >= 0.3 with n >= minDays
  checked: number;
}

export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

/** Averages each score per local day (several entries a day collapse into one point). */
function dailyScores(entries: Entry[], key: 'energy' | 'mood'): Map<string, number> {
  const sums = new Map<string, { s: number; n: number }>();
  for (const e of entries) {
    const v = e[key];
    if (v == null) continue;
    const d = localDate(e.at);
    const cur = sums.get(d) ?? { s: 0, n: 0 };
    sums.set(d, { s: cur.s + v, n: cur.n + 1 });
  }
  return new Map([...sums].map(([d, { s, n }]) => [d, s / n]));
}

const nextDay = (d: string) => localDate(new Date(`${d}T12:00:00`).getTime() + 86_400_000);

export function correlate(entries: Entry[], activity: Map<string, DayActivity>, minDays = MIN_DAYS): CorrelationReport {
  const findings: Correlation[] = [];
  let checked = 0;
  const counts = { energy: 0, mood: 0 };
  for (const score of ['energy', 'mood'] as const) {
    const days = dailyScores(entries, score);
    counts[score] = days.size;
    if (days.size < minDays) continue;
    for (const measure of ['projects touched', 'commits'] as const) {
      for (const lag of ['same day', 'next day'] as const) {
        const xs: number[] = [];
        const ys: number[] = [];
        for (const [d, v] of days) {
          const a = activity.get(lag === 'same day' ? d : nextDay(d)) ?? { projects: 0, commits: 0 };
          xs.push(v);
          ys.push(measure === 'commits' ? a.commits : a.projects);
        }
        checked++;
        const r = pearson(xs, ys);
        if (Math.abs(r) >= 0.3) findings.push({ score, measure, lag, r: Number(r.toFixed(2)), n: xs.length });
      }
    }
  }
  return { scoredDays: counts, minDays, findings, checked };
}

export function describeCorrelation(c: Correlation): string {
  const dir = c.r > 0 ? 'higher' : 'lower';
  const strength = Math.abs(c.r) >= 0.6 ? 'fairly strong' : 'modest';
  const when = c.lag === 'same day' ? 'the same day' : 'the following day';
  return `On days you logged higher ${c.score}, ${c.measure} tended to be ${dir} ${when} (r=${c.r}, n=${c.n} days, ${strength}).`;
}
