// Portfolio-level synthesis over all profiles. Cached by a hash of its inputs.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { localDate } from '../db.ts';
import type { DatabaseSync } from '../fs/guard.ts';
import { writeText } from '../fs/guard.ts';
import type { LLMProvider } from '../llm/provider.ts';
import { DATA_DIR } from '../paths.ts';
import type { ProjectView } from '../store.ts';
import { getProfile } from './profile.ts';

export interface PortfolioReport {
  headline: string;
  active: { project: string; note: string }[];
  closeToShipping: { project: string; note: string }[];
  stalled: { project: string; note: string }[];
  quietlyAbandoned: { project: string; note: string }[];
  overlaps: { projects: string[]; note: string }[];
  observations: string[];
  suggestedFocus: { project: string; why: string };
}

const item = { type: 'object', required: ['project', 'note'], properties: { project: { type: 'string' }, note: { type: 'string' } } };

export const PORTFOLIO_SCHEMA = {
  type: 'object',
  required: ['headline', 'active', 'closeToShipping', 'stalled', 'quietlyAbandoned', 'overlaps', 'observations', 'suggestedFocus'],
  properties: {
    headline: { type: 'string', description: 'One honest sentence about the state of the studio right now.' },
    active: { type: 'array', items: item, description: 'What is genuinely moving.' },
    closeToShipping: { type: 'array', items: item, description: 'Close to done, and what stands in the way.' },
    stalled: { type: 'array', items: item, description: 'Mid-flight but stuck. Where it stopped.' },
    quietlyAbandoned: { type: 'array', items: item, maxItems: 12, description: 'Dormant work never explicitly closed. Only the notable ones.' },
    overlaps: {
      type: 'array',
      items: { type: 'object', required: ['projects', 'note'], properties: { projects: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } } },
      description: 'Projects that duplicate or could merge with each other.',
    },
    observations: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Portfolio-level patterns, each grounded in the list.' },
    suggestedFocus: {
      type: 'object', required: ['project', 'why'],
      properties: { project: { type: 'string' }, why: { type: 'string' } },
      description: 'If Colton picked one thing this week, which and why.',
    },
  },
} as const;

const SYSTEM = `You are the studio manager for Colton (Alternative Design, a one-person creative-tech studio).
You get one line per project: activity facts plus a short profile written earlier. Synthesize the whole portfolio.
- Use project names exactly as given.
- Ground everything in the list. Separate facts from interpretation. If something is a guess, say "looks like".
- Be warm but direct. No flattery, no generic productivity advice.
- Many old repos are normal. Don't moralize about them. Surface only what is actually useful.`;

function line(p: ProjectView, db: DatabaseSync): string {
  const f = p.facts;
  const prof = getProfile(db, p)?.profile;
  const facts = [
    p.state,
    `last ${f.lastActivityAt ? new Date(f.lastActivityAt).toISOString().slice(0, 10) : 'n/a'}`,
    f.git ? `${f.git.commits30} commits/30d, ${f.git.commitCount} total, ${f.git.modified + f.git.untracked} uncommitted` : `${f.touched30} files touched/30d`,
    f.stack.slice(0, 3).join('+') || p.kind,
  ].join('; ');
  const profile = prof
    ? `${prof.category}/${prof.stage}/${prof.closeness}: ${prof.summary} NEXT: ${prof.nextStep}${prof.risks.length ? ` RISKS: ${prof.risks.join('; ')}` : ''}`
    : 'no profile';
  return `- ${p.name} [${facts}] ${profile}`;
}

export function portfolioInput(db: DatabaseSync, projects: ProjectView[]): string {
  return `Today: ${localDate()}\n${projects.length} projects, most recent first:\n\n${projects.map((p) => line(p, db)).join('\n')}`;
}

export function latestPortfolio(db: DatabaseSync): { report: PortfolioReport; generatedAt: number; inputHash: string } | null {
  const r = db.prepare("SELECT json, generated_at, input_hash FROM reports WHERE kind = 'portfolio' ORDER BY id DESC LIMIT 1").get() as
    { json: string; generated_at: number; input_hash: string } | undefined;
  return r ? { report: JSON.parse(r.json) as PortfolioReport, generatedAt: r.generated_at, inputHash: r.input_hash } : null;
}

export async function synthesizePortfolio(
  db: DatabaseSync, llm: LLMProvider, model: string, projects: ProjectView[], force = false, outDir = DATA_DIR,
): Promise<{ report: PortfolioReport; generatedAt: number; cached: boolean }> {
  const input = portfolioInput(db, projects);
  // Hash without the date line, so an unchanged portfolio stays cached across days.
  const inputHash = createHash('sha1').update(input.slice(input.indexOf('\n') + 1)).digest('hex');
  const last = latestPortfolio(db);
  if (!force && last && last.inputHash === inputHash) return { report: last.report, generatedAt: last.generatedAt, cached: true };

  const report = await llm.complete<PortfolioReport>({ system: SYSTEM, prompt: input, schema: PORTFOLIO_SCHEMA, model });
  const generatedAt = Date.now();
  db.prepare("INSERT INTO reports (kind, input_hash, generated_at, model, json) VALUES ('portfolio', ?, ?, ?, ?)")
    .run(inputHash, generatedAt, model, JSON.stringify(report));
  writeText(join(outDir, 'reports', `portfolio-${localDate(generatedAt)}.md`), portfolioMarkdown(report, generatedAt));
  return { report, generatedAt, cached: false };
}

export function portfolioMarkdown(r: PortfolioReport, generatedAt: number): string {
  const list = (title: string, items: { project: string; note: string }[]) =>
    items.length ? [`## ${title}`, '', ...items.map((i) => `- **${i.project}**: ${i.note}`), ''] : [];
  return [
    `# Studio report · ${localDate(generatedAt)}`,
    '',
    r.headline,
    '',
    ...list('Moving', r.active),
    ...list('Close to shipping', r.closeToShipping),
    ...list('Stalled', r.stalled),
    ...list('Quietly abandoned', r.quietlyAbandoned),
    ...(r.overlaps.length ? ['## Overlaps', '', ...r.overlaps.map((o) => `- ${o.projects.join(' · ')}: ${o.note}`), ''] : []),
    ...(r.observations.length ? ['## Observations', '', ...r.observations.map((o) => `- ${o}`), ''] : []),
    '## If you pick one thing',
    '',
    `**${r.suggestedFocus.project}**: ${r.suggestedFocus.why}`,
    '',
  ].join('\n');
}
