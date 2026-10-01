// The therapist: 2–4 specific questions grounded in what the data shows.
// Falls back to rule-based questions when the LLM is unavailable.

import type { DatabaseSync } from '../fs/guard.ts';
import type { LLMProvider } from '../llm/provider.ts';
import { latestProjects, type ProjectView } from '../store.ts';
import { latestPortfolio } from '../understand/portfolio.ts';
import { localDate } from '../util.ts';
import { entriesSince, recentCheckins, type Question } from './journal.ts';

const DAY = 86_400_000;

export interface CheckinContext {
  today: string;
  week: { touched: string[]; commits: number; shipped: string[] };
  month: { touched: number; started: string[] };
  focus: { name: string; activeDays30: number } | null;
  stalledClose: string[]; // quiet projects whose profile says close to shipping
  journal: { entries: number; avgEnergy: number | null; avgMood: number | null; texts?: string[] };
  previousQuestions: string[];
  headline: string | null;
}

export function buildContext(db: DatabaseSync, journal: DatabaseSync, opts: { shareText: boolean }, now = Date.now()): CheckinContext {
  const today = localDate(now);
  const weekAgo = localDate(now - 7 * DAY);
  const monthAgo = localDate(now - 30 * DAY);
  const projects = latestProjects(db, now);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const days = db.prepare('SELECT project_id, date, source, count FROM activity_days WHERE date > ?').all(monthAgo) as
    { project_id: string; date: string; source: string; count: number }[];
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const notForeign = (id: string) => !byId.get(id)?.facts.git?.foreign;

  const weekRows = days.filter((d) => d.date > weekAgo && notForeign(d.project_id));
  const monthRows = days.filter((d) => notForeign(d.project_id));
  const shipped = db.prepare(`
    SELECT DISTINCT project_id FROM signals WHERE date > ?
    UNION SELECT DISTINCT project_id FROM events WHERE type = 'shipped' AND date > ?`).all(weekAgo, weekAgo) as { project_id: string }[];
  const firstDays = db.prepare('SELECT project_id, min(date) AS first FROM activity_days GROUP BY project_id HAVING first > ?').all(monthAgo) as
    { project_id: string; first: string }[];

  const activeDays = new Map<string, Set<string>>();
  for (const r of monthRows) activeDays.set(r.project_id, (activeDays.get(r.project_id) ?? new Set()).add(r.date));
  const top = [...activeDays.entries()].sort((a, b) => b[1].size - a[1].size)[0];

  const stalledClose = projects
    .filter((p: ProjectView) => p.state === 'cooling' || p.state === 'dormant')
    .filter((p) => {
      const r = db.prepare('SELECT json FROM profiles WHERE project_id = ? ORDER BY generated_at DESC LIMIT 1').get(p.id) as { json: string } | undefined;
      return r ? (JSON.parse(r.json) as { closeness?: string }).closeness === 'close' : false;
    })
    .map((p) => p.name)
    .slice(0, 5);

  const entries = entriesSince(journal, now - 14 * DAY);
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)) : null;
  };

  return {
    today,
    week: {
      touched: [...new Set(weekRows.map((r) => nameOf(r.project_id)))],
      commits: weekRows.filter((r) => r.source === 'git').reduce((a, r) => a + r.count, 0),
      shipped: shipped.map((s) => nameOf(s.project_id)),
    },
    month: { touched: activeDays.size, started: firstDays.filter((f) => notForeign(f.project_id)).map((f) => nameOf(f.project_id)) },
    focus: top ? { name: nameOf(top[0]), activeDays30: top[1].size } : null,
    stalledClose,
    journal: {
      entries: entries.length,
      avgEnergy: avg(entries.map((e) => e.energy)),
      avgMood: avg(entries.map((e) => e.mood)),
      ...(opts.shareText ? { texts: entries.slice(0, 10).map((e) => e.text) } : {}),
    },
    previousQuestions: recentCheckins(journal, 3).flatMap((c) => c.questions.map((q) => q.question)),
    headline: latestPortfolio(db)?.report.headline ?? null,
  };
}

export const CHECKIN_SCHEMA = {
  type: 'object',
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      minItems: 2,
      maxItems: 4,
      items: {
        type: 'object',
        required: ['question', 'basis'],
        properties: {
          question: { type: 'string', description: 'One short, specific question.' },
          basis: { type: 'string', description: 'The data point behind it, in a few words.' },
        },
      },
    },
  },
} as const;

const SYSTEM = `You run a short weekly check-in for Colton, a one-person creative-tech studio owner. You are his studio manager with a bit of a therapist's ear.
Write 2–4 questions grounded in the context data.
- Each question must reference something specific in the data (a project name, a count, a change).
- Warm but direct. Curious, not preachy. Never flatter, never diagnose, never give advice disguised as a question.
- Short: one sentence each, plain words. Example tone: "You touched 6 projects this week and shipped none. What's pulling you around?"
- Don't repeat the previous questions listed in the context.
- If the data is thin, ask about that honestly instead of inventing a story.`;

export async function llmQuestions(llm: LLMProvider, model: string, ctx: CheckinContext): Promise<Question[]> {
  const r = await llm.complete<{ questions: Question[] }>({
    task: 'checkin',
    system: SYSTEM,
    prompt: `Context (JSON):\n${JSON.stringify(ctx, null, 1)}`,
    schema: CHECKIN_SCHEMA,
    model,
  });
  return r.questions.slice(0, 4);
}

/** Deterministic questions from the same context, used when the LLM is unavailable. */
export function fallbackQuestions(ctx: CheckinContext): Question[] {
  const q: Question[] = [];
  const n = ctx.week.touched.length;
  if (n >= 3 && !ctx.week.shipped.length) {
    q.push({ question: `You touched ${n} projects this week and shipped none. What's pulling you around?`, basis: `${n} projects touched, 0 ship signals` });
  } else if (n === 0) {
    q.push({ question: 'Nothing moved in your project folders this week. Was that rest, other work, or avoidance?', basis: 'no activity in 7 days' });
  } else if (ctx.week.shipped.length) {
    q.push({ question: `${ctx.week.shipped.join(', ')} showed ship signals this week. What made finishing possible this time?`, basis: 'ship signal this week' });
  }
  if (ctx.focus && ctx.focus.activeDays30 >= 5) {
    q.push({ question: `${ctx.focus.name} got ${ctx.focus.activeDays30} active days this month. Is it getting the attention you'd choose to give it?`, basis: 'top project by active days' });
  }
  if (ctx.stalledClose.length) {
    q.push({ question: `${ctx.stalledClose[0]} looked close to shipping before it went quiet. What stopped it?`, basis: 'profile: close to shipping, now quiet' });
  }
  if (ctx.month.started.length >= 2) {
    q.push({ question: `You started ${ctx.month.started.length} new things this month (${ctx.month.started.length > 3 ? 'including ' : ''}${ctx.month.started.slice(0, 3).join(', ')}). What were you hoping each one would give you?`, basis: 'new projects in 30 days' });
  }
  if (!ctx.journal.entries) {
    q.push({ question: 'No journal entries in two weeks. How has your energy actually been?', basis: 'empty journal' });
  }
  const fresh = q.filter((x) => !ctx.previousQuestions.includes(x.question));
  return (fresh.length >= 2 ? fresh : q).slice(0, 4);
}
