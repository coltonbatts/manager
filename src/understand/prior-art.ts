// "You've built this before": checks a young project against every other profile.
// Stage 1 picks likely relatives from the whole catalog. Stage 2 looks at those
// relatives' file lists (names only) and points at what's worth reusing.

import type { DatabaseSync } from '../fs/guard.ts';
import { isSecretPath, listFiles } from '../fs/read.ts';
import type { LLMProvider } from '../llm/provider.ts';
import { tildify } from '../paths.ts';
import type { ProjectView } from '../store.ts';
import { localDate, pool } from '../util.ts';
import { getProfile } from './profile.ts';

const DAY = 86_400_000;
export const YOUNG_DAYS = 30;

export interface PriorArt {
  headline: string; // one line, e.g. "This is the ninth DMC matcher you've started."
  related: {
    project: string;
    relation: 'same-idea' | 'predecessor' | 'shared-part';
    reached: string; // how far that one got
    reuse: { path: string; why: string }[];
  }[];
  advice: string; // continue here, fold into X, lift Y from Z…
}

const CANDIDATES_SCHEMA = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      maxItems: 5,
      items: { type: 'object', required: ['project', 'why'], properties: { project: { type: 'string' }, why: { type: 'string' } } },
    },
  },
} as const;

export const PRIOR_ART_SCHEMA = {
  type: 'object',
  required: ['headline', 'related', 'advice'],
  properties: {
    headline: { type: 'string', description: 'One honest line. Empty string if nothing is genuinely related.' },
    related: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        required: ['project', 'relation', 'reached', 'reuse'],
        properties: {
          project: { type: 'string' },
          relation: { type: 'string', enum: ['same-idea', 'predecessor', 'shared-part'] },
          reached: { type: 'string', description: 'How far that project got, from its profile.' },
          reuse: {
            type: 'array', maxItems: 4,
            items: { type: 'object', required: ['path', 'why'], properties: { path: { type: 'string' }, why: { type: 'string' } } },
            description: 'Specific files or folders from its file list worth lifting. Only paths that appear in the list.',
          },
        },
      },
    },
    advice: { type: 'string', description: 'One or two sentences: continue here, fold into another project, or lift parts.' },
  },
} as const;

const STAGE1 = `You help Colton, a one-person creative-tech studio owner, notice when he is rebuilding something he has built before.
You get one NEW project and a catalog of all his other projects. Pick up to 5 that are genuinely related:
the same idea, an earlier attempt at it, or a project containing a part the new one needs.
Shared tech stack alone is NOT enough. If nothing is truly related, return an empty list.`;

const STAGE2 = `You help Colton reuse his own earlier work instead of rebuilding it.
You get a NEW project and a few related earlier projects with their profiles and file lists (names only).
- Say plainly how they relate and how far each got.
- Point at specific files or folders worth lifting. Only cite paths that appear in the file lists.
- Advice should be practical: keep going here, fold this into an existing project, or lift specific parts.
- No moralizing about starting new things. Sometimes a fresh start is right; say so if the evidence suggests it.`;

function catalogLine(db: DatabaseSync, p: ProjectView): string {
  const prof = getProfile(db, p)?.profile;
  const g = p.facts.git;
  return `- ${p.name}: ${prof ? `${prof.summary} [${prof.stage}, ${prof.closeness}]` : p.kind} · ${p.facts.stack.slice(0, 3).join('+') || '—'} · ${g ? `${g.commitCount} commits` : `${p.facts.fileCount} files`} · last ${p.facts.lastActivityAt ? localDate(p.facts.lastActivityAt) : 'n/a'}`;
}

function describe(db: DatabaseSync, p: ProjectView): string {
  const prof = getProfile(db, p)?.profile;
  return [
    `${p.name} (${tildify(p.path)})`,
    prof ? `${prof.summary}\nNow: ${prof.currentState}\nStage: ${prof.stage}, ${prof.closeness}` : `kind: ${p.kind}`,
    `stack: ${p.facts.stack.join(', ') || '—'} · first activity → last: ${p.facts.git?.firstCommitAt ? localDate(p.facts.git.firstCommitAt) : '?'} → ${p.facts.lastActivityAt ? localDate(p.facts.lastActivityAt) : '?'}`,
  ].join('\n');
}

async function fileList(p: ProjectView, max = 150): Promise<string> {
  const { files } = await listFiles(p.path, p.facts.git !== null, { maxFiles: 4000 });
  const code = files.filter((f) => !isSecretPath(f.rel) && !/\.(png|jpe?g|gif|webp|svg|ico|mp4|mov|wav|mp3|lock)$/i.test(f.rel) && !/(^|\/)package-lock\.json$/.test(f.rel));
  const list = code.map((f) => f.rel).sort();
  return list.length > max ? `${list.slice(0, max).join('\n')}\n… ${list.length - max} more` : list.join('\n');
}

export function firstActivity(db: DatabaseSync, id: string): string | null {
  return (db.prepare('SELECT min(date) AS d FROM activity_days WHERE project_id = ?').get(id) as { d: string | null }).d;
}

export function isYoung(db: DatabaseSync, p: ProjectView, now = Date.now()): boolean {
  if (p.facts.git?.foreign || !p.facts.fileCount) return false;
  // Prefer your first commit: file dates in a git repo can reflect a recent clone of old work.
  const first = p.facts.git?.firstCommitAt ? localDate(p.facts.git.firstCommitAt) : firstActivity(db, p.id);
  return first !== null && first >= localDate(now - YOUNG_DAYS * DAY);
}

export function getPriorArt(db: DatabaseSync, id: string): { result: PriorArt; generatedAt: number } | null {
  const r = db.prepare('SELECT json, generated_at FROM prior_art WHERE project_id = ?').get(id) as { json: string; generated_at: number } | undefined;
  return r ? { result: JSON.parse(r.json) as PriorArt, generatedAt: r.generated_at } : null;
}

export async function checkPriorArt(db: DatabaseSync, llm: LLMProvider, model: string, p: ProjectView, all: ProjectView[], scanModel = model): Promise<PriorArt> {
  const others = all.filter((o) => o.id !== p.id && !o.facts.git?.foreign && o.facts.fileCount);
  const stage1 = await llm.complete<{ candidates: { project: string; why: string }[] }>({
    task: 'prior-art-scan',
    system: STAGE1,
    prompt: `NEW PROJECT\n${describe(db, p)}\n\nCATALOG (${others.length} projects)\n${others.map((o) => catalogLine(db, o)).join('\n')}`,
    schema: CANDIDATES_SCHEMA,
    model: scanModel,
  });
  const byName = new Map(others.map((o) => [o.name.toLowerCase(), o]));
  const picked = [...new Set(stage1.candidates.map((c) => c.project.toLowerCase()))]
    .map((n) => byName.get(n))
    .filter((o): o is ProjectView => Boolean(o))
    .slice(0, 4);

  let result: PriorArt = { headline: '', related: [], advice: '' };
  if (picked.length) {
    const blocks = await Promise.all(picked.map(async (o) => `### ${o.name}\n${describe(db, o)}\nFiles:\n${await fileList(o)}`));
    result = await llm.complete<PriorArt>({
      task: 'prior-art',
      system: STAGE2,
      prompt: `NEW PROJECT\n${describe(db, p)}\nFiles:\n${await fileList(p, 60)}\n\nRELATED EARLIER PROJECTS\n\n${blocks.join('\n\n')}`,
      schema: PRIOR_ART_SCHEMA,
      model,
    });
    // Keep only real projects and real paths; the model must not invent either.
    const lists = new Map(await Promise.all(picked.map(async (o) => [o.name.toLowerCase(), new Set((await fileList(o, 100_000)).split('\n'))] as const)));
    result.related = result.related
      .filter((r) => lists.has(r.project.toLowerCase()))
      .map((r) => ({
        ...r,
        project: picked.find((o) => o.name.toLowerCase() === r.project.toLowerCase())!.name,
        reuse: r.reuse.filter((u) => {
          const files = lists.get(r.project.toLowerCase())!;
          const path = u.path.replace(/\/$/, '');
          return files.has(path) || [...files].some((f) => f.startsWith(path + '/'));
        }),
      }));
  }
  db.prepare('INSERT OR REPLACE INTO prior_art (project_id, generated_at, model, json) VALUES (?, ?, ?, ?)')
    .run(p.id, Date.now(), model, JSON.stringify(result));
  return result;
}

/** Checks every young project that hasn't been checked yet. */
export async function refreshPriorArt(
  db: DatabaseSync, llm: LLMProvider, model: string, projects: ProjectView[], opts: { concurrency: number; now?: number; scanModel?: string },
): Promise<{ checked: number; withMatches: number; failed: { project: ProjectView; error: string }[] }> {
  const due = projects.filter((p) => isYoung(db, p, opts.now) && !getPriorArt(db, p.id));
  const out = { checked: 0, withMatches: 0, failed: [] as { project: ProjectView; error: string }[] };
  await pool(due, opts.concurrency, async (p) => {
    try {
      const r = await checkPriorArt(db, llm, model, p, projects, opts.scanModel);
      out.checked++;
      if (r.related.length) out.withMatches++;
    } catch (err) {
      out.failed.push({ project: p, error: (err as Error).message });
    }
  });
  return out;
}
