// Per-project profiles, cached by fingerprint: a project is only re-profiled
// when its cheap facts (head, dirty files, newest mtime, size) change.

import { join } from 'node:path';
import type { DatabaseSync } from '../fs/guard.ts';
import { writeText } from '../fs/guard.ts';
import type { LLMProvider } from '../llm/provider.ts';
import { DATA_DIR, tildify } from '../paths.ts';
import type { ProjectView } from '../store.ts';
import { pool } from '../util.ts';
import { buildDigest } from './digest.ts';

export interface Profile {
  summary: string;
  category: 'client' | 'product' | 'tool' | 'experiment' | 'creative' | 'learning' | 'personal' | 'template' | 'unclear';
  stage: 'idea' | 'exploring' | 'building' | 'polishing' | 'shipped' | 'maintaining' | 'stalled' | 'abandoned';
  currentState: string;
  nextStep: string;
  risks: string[];
  closeness: 'not-applicable' | 'far' | 'midway' | 'close' | 'shipped';
  confidence: 'low' | 'medium' | 'high';
}

export const PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'category', 'stage', 'currentState', 'nextStep', 'risks', 'closeness', 'confidence'],
  properties: {
    summary: { type: 'string', description: 'What this is, in one or two plain sentences.' },
    category: { type: 'string', enum: ['client', 'product', 'tool', 'experiment', 'creative', 'learning', 'personal', 'template', 'unclear'] },
    stage: { type: 'string', enum: ['idea', 'exploring', 'building', 'polishing', 'shipped', 'maintaining', 'stalled', 'abandoned'] },
    currentState: { type: 'string', description: 'Where it actually is right now, grounded in the evidence (1-2 sentences).' },
    nextStep: { type: 'string', description: 'The single most apparent next concrete step, or "none — appears finished/abandoned".' },
    risks: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'What looks stalled or at risk. Empty if nothing notable.' },
    closeness: { type: 'string', enum: ['not-applicable', 'far', 'midway', 'close', 'shipped'], description: 'How close to shipping/finished.' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How much evidence the digest gives you.' },
  },
} as const;

const SYSTEM = `You are the studio manager for Colton, who runs Alternative Design, a one-person creative-tech studio (code, video, design, photography, painting).
You are given a factual digest of ONE project folder. Profile it.
- Ground every claim in the digest. If the evidence is thin, say so and set confidence to low; do not invent features, users or deadlines.
- Dates matter: compare last activity to today's date.
- "stalled" = clearly mid-flight but untouched for weeks; "abandoned" = untouched for many months with no sign of completion; "shipped" needs evidence (deploy config, release tags, a live URL, a "launch" commit…).
- Be specific and plain. No praise, no filler.`;

export interface StoredProfile {
  profile: Profile;
  fingerprint: string;
  generatedAt: number;
  model: string;
  fresh: boolean;
}

export function getProfile(db: DatabaseSync, p: ProjectView): StoredProfile | null {
  const r = db.prepare('SELECT fingerprint, generated_at, model, json FROM profiles WHERE project_id = ? ORDER BY generated_at DESC LIMIT 1').get(p.id) as
    { fingerprint: string; generated_at: number; model: string; json: string } | undefined;
  if (!r) return null;
  return { profile: JSON.parse(r.json) as Profile, fingerprint: r.fingerprint, generatedAt: r.generated_at, model: r.model, fresh: r.fingerprint === p.facts.fingerprint };
}

function profileMarkdown(p: ProjectView, prof: Profile, generatedAt: number): string {
  return [
    `# ${p.name}`,
    '',
    `${tildify(p.path)} · ${prof.category} · ${prof.stage} · profiled ${new Date(generatedAt).toISOString().slice(0, 10)} (${prof.confidence} confidence)`,
    '',
    prof.summary,
    '',
    `**Now:** ${prof.currentState}`,
    '',
    `**Next:** ${prof.nextStep}`,
    '',
    ...(prof.risks.length ? ['**Risks**', '', ...prof.risks.map((r) => `- ${r}`), ''] : []),
  ].join('\n');
}

/** `outDir` receives the markdown copy (tests point it at their temp dir). */
export async function generateProfile(db: DatabaseSync, llm: LLMProvider, model: string, p: ProjectView, outDir = DATA_DIR): Promise<StoredProfile> {
  const digest = await buildDigest(p);
  const profile = await llm.complete<Profile>({ system: SYSTEM, prompt: digest, schema: PROFILE_SCHEMA, model });
  const generatedAt = Date.now();
  db.prepare('INSERT OR REPLACE INTO profiles (project_id, fingerprint, generated_at, model, json) VALUES (?, ?, ?, ?, ?)')
    .run(p.id, p.facts.fingerprint, generatedAt, model, JSON.stringify(profile));
  writeText(join(outDir, 'profiles', `${p.id}.md`), profileMarkdown(p, profile, generatedAt));
  return { profile, fingerprint: p.facts.fingerprint, generatedAt, model, fresh: true };
}

export interface RefreshResult {
  generated: number;
  cached: number;
  failed: { project: ProjectView; error: string }[];
}

/** Profiles every project whose fingerprint changed since its last profile. */
export async function refreshProfiles(
  db: DatabaseSync, llm: LLMProvider, model: string, projects: ProjectView[],
  opts: { force?: boolean; concurrency: number; outDir?: string; onProgress?: (done: number, total: number, p: ProjectView) => void },
): Promise<RefreshResult> {
  const stale = projects.filter((p) => opts.force || !getProfile(db, p)?.fresh);
  const result: RefreshResult = { generated: 0, cached: projects.length - stale.length, failed: [] };
  let done = 0;
  await pool(stale, opts.concurrency, async (p) => {
    try {
      await generateProfile(db, llm, model, p, opts.outDir);
      result.generated++;
    } catch (err) {
      result.failed.push({ project: p, error: (err as Error).message });
    }
    opts.onProgress?.(++done, stale.length, p);
  });
  return result;
}
