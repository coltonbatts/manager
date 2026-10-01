// "Where you left off": a short re-entry note for a project you stepped away from.
// Built from the last work session: its commits, uncommitted changes, touched
// files and nearby TODOs. Stale as soon as the project's fingerprint changes.

import { join } from 'node:path';
import type { DatabaseSync } from '../fs/guard.ts';
import { writeText } from '../fs/guard.ts';
import { isSecretPath, listFiles, readTextSafe } from '../fs/read.ts';
import { git } from '../git.ts';
import type { LLMProvider } from '../llm/provider.ts';
import { DATA_DIR, tildify } from '../paths.ts';
import type { ProjectView } from '../store.ts';
import { localDate, pool } from '../util.ts';
import { redact } from './redact.ts';

const DAY = 86_400_000;
export const QUIET_MIN_DAYS = 2;
export const QUIET_MAX_DAYS = 60;

export interface ReentryNote {
  lastSession: string; // when, and what you were doing
  inFlight: string[]; // unfinished things, with file references
  firstStep: string; // one concrete ~15-minute move to get back in
  remember: string[]; // context worth not rediscovering (commands, gotchas, decisions)
  confidence: 'low' | 'medium' | 'high';
}

export const REENTRY_SCHEMA = {
  type: 'object',
  required: ['lastSession', 'inFlight', 'firstStep', 'remember', 'confidence'],
  properties: {
    lastSession: { type: 'string', description: 'One or two sentences: when the last session was and what you were doing in it.' },
    inFlight: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Unfinished work, citing files where possible.' },
    firstStep: { type: 'string', description: 'One concrete first move that takes ~15 minutes, naming the file or command.' },
    remember: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Context worth not rediscovering: commands, decisions, gotchas.' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
} as const;

const SYSTEM = `You write re-entry notes for Colton, a one-person creative-tech studio owner, so he can pick a project back up in minutes instead of an hour.
You get evidence from his LAST work session on one project: commits, uncommitted diffs, touched files, TODOs, and notes.
- Write to him in second person, plain and specific. Cite file paths.
- Distinguish what's done (committed) from what's in flight (uncommitted, TODO, half-built).
- The first step must be small and concrete enough to start cold: one file, one command, one check.
- Don't invent context. If the evidence is thin, say so and set confidence low.`;

/** The last run of consecutive active days (gaps of ≤ 1 day), capped at 7 days. */
export function lastSession(days: string[]): { start: string; end: string } | null {
  if (!days.length) return null;
  const sorted = [...days].sort();
  let start = sorted[sorted.length - 1];
  const end = start;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const gap = (Date.parse(`${start}T12:00:00`) - Date.parse(`${sorted[i]}T12:00:00`)) / DAY;
    if (gap > 2 || (Date.parse(`${end}T12:00:00`) - Date.parse(`${sorted[i]}T12:00:00`)) / DAY > 6) break;
    start = sorted[i];
  }
  return { start, end };
}

/** Drops diff sections for secret-like paths and caps the size of each file's hunk. */
export function filterDiff(diff: string, perFile = 1500, total = 7000): string {
  const sections = diff.split(/(?=^diff --git )/m).filter((s) => s.startsWith('diff --git '));
  let out = '';
  for (const sec of sections) {
    const path = /^diff --git a\/(.+?) b\//.exec(sec)?.[1] ?? '';
    if (!path || isSecretPath(path)) continue;
    const piece = sec.length > perFile ? sec.slice(0, perFile) + '\n…(hunk truncated)\n' : sec;
    if (out.length + piece.length > total) { out += `\n…(more files changed)`; break; }
    out += piece;
  }
  return out;
}

export function isEligible(p: ProjectView, now = Date.now()): boolean {
  const last = p.facts.lastActivityAt;
  if (!last || p.facts.git?.foreign || !p.facts.fileCount) return false;
  const days = (now - last) / DAY;
  return days >= QUIET_MIN_DAYS && days <= QUIET_MAX_DAYS;
}

export async function buildReentryEvidence(db: DatabaseSync, p: ProjectView): Promise<string> {
  const days = (db.prepare('SELECT DISTINCT date FROM activity_days WHERE project_id = ?').all(p.id) as { date: string }[]).map((r) => r.date);
  const session = lastSession(days);
  const out: string[] = [];
  const section = (t: string, b: string | null | undefined) => { if (b?.trim()) out.push(`## ${t}\n${b.trim()}`); };

  section('Project', `${p.name} · ${tildify(p.path)} · ${p.kind}${p.facts.stack.length ? ` · ${p.facts.stack.join(', ')}` : ''}\ntoday: ${localDate()}   last session: ${session ? `${session.start} → ${session.end}` : 'unknown'}`);
  const prof = db.prepare('SELECT json FROM profiles WHERE project_id = ? ORDER BY generated_at DESC LIMIT 1').get(p.id) as { json: string } | undefined;
  if (prof) {
    const j = JSON.parse(prof.json) as { summary: string; currentState: string; nextStep: string };
    section('Profile (written earlier)', `${j.summary}\nNow: ${j.currentState}\nNext: ${j.nextStep}`);
  }

  if (p.facts.git && session) {
    const since = `${session.start} 00:00`;
    const until = `${session.end} 23:59`;
    section('Commits in the last session', await git(p.path, ['log', '--branches', `--since=${since}`, `--until=${until}`, '--format=%n%h %cs %s', '--stat=100', '-n', '40']));
    const status = await git(p.path, ['status', '--porcelain=v1']);
    const lines = (status ?? '').split('\n').filter(Boolean);
    const untracked = lines.filter((l) => l.startsWith('??')).map((l) => l.slice(3)).filter((f) => !isSecretPath(f));
    if (untracked.length) section('Untracked (new, never committed)', untracked.slice(0, 25).join('\n'));
    if (p.facts.git.commitCount) {
      section('Uncommitted changes (diff vs HEAD)', filterDiff(await git(p.path, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', '-U2']) ?? ''));
    }
  }

  // Files touched in the last session, and TODOs inside them.
  const { files } = await listFiles(p.path, p.facts.git !== null, { maxFiles: 5000 });
  const from = session ? Date.parse(`${session.start}T00:00:00`) : (p.facts.lastActivityAt ?? 0) - 3 * DAY;
  const touched = files.filter((f) => f.mtimeMs >= from).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 25);
  section('Files modified in the last session', touched.map((f) => `${localDate(f.mtimeMs)}  ${f.rel}`).join('\n'));
  const todos: string[] = [];
  for (const f of touched) {
    if (todos.length >= 15 || f.size > 256 * 1024) continue;
    let text: string | null = null;
    try { text = readTextSafe(join(p.path, f.rel)); } catch { continue; }
    text?.split('\n').forEach((line, i) => {
      if (todos.length < 15 && /\b(TODO|FIXME)\b/.test(line)) todos.push(`${f.rel}:${i + 1}  ${line.trim().slice(0, 160)}`);
    });
  }
  section('TODO/FIXME in those files', todos.join('\n'));

  for (const name of ['HANDOFF.md', 'TODO.md', 'NOTES.md', 'PLAN.md', 'STATUS.md']) {
    const rel = files.find((f) => f.rel.toLowerCase() === name.toLowerCase())?.rel;
    if (!rel) continue;
    try { section(rel, readTextSafe(join(p.path, rel))?.slice(0, 1500)); } catch { /* secret-like */ }
  }
  return redact(out.join('\n\n')).slice(0, 16_000);
}

export interface StoredNote {
  note: ReentryNote;
  generatedAt: number;
  fresh: boolean;
}

export function getReentryNote(db: DatabaseSync, p: ProjectView): StoredNote | null {
  const r = db.prepare('SELECT fingerprint, generated_at, json FROM reentry_notes WHERE project_id = ? ORDER BY generated_at DESC LIMIT 1').get(p.id) as
    { fingerprint: string; generated_at: number; json: string } | undefined;
  return r ? { note: JSON.parse(r.json) as ReentryNote, generatedAt: r.generated_at, fresh: r.fingerprint === p.facts.fingerprint } : null;
}

export function noteMarkdown(p: ProjectView, n: ReentryNote, at: number): string {
  return [
    `# Where you left off: ${p.name}`, '',
    `${tildify(p.path)} · written ${localDate(at)} (${n.confidence} confidence)`, '',
    n.lastSession, '',
    ...(n.inFlight.length ? ['**In flight**', '', ...n.inFlight.map((x) => `- ${x}`), ''] : []),
    `**First step:** ${n.firstStep}`, '',
    ...(n.remember.length ? ['**Remember**', '', ...n.remember.map((x) => `- ${x}`), ''] : []),
  ].join('\n');
}

export async function generateReentryNote(db: DatabaseSync, llm: LLMProvider, model: string, p: ProjectView, outDir = DATA_DIR): Promise<StoredNote> {
  const evidence = await buildReentryEvidence(db, p);
  const note = await llm.complete<ReentryNote>({ task: 'reentry', system: SYSTEM, prompt: evidence, schema: REENTRY_SCHEMA, model });
  const generatedAt = Date.now();
  db.prepare('INSERT OR REPLACE INTO reentry_notes (project_id, fingerprint, generated_at, model, json) VALUES (?, ?, ?, ?, ?)')
    .run(p.id, p.facts.fingerprint, generatedAt, model, JSON.stringify(note));
  writeText(join(outDir, 'reentry', `${p.id}.md`), noteMarkdown(p, note, generatedAt));
  return { note, generatedAt, fresh: true };
}

/** Writes notes for every recently-quiet project whose note is missing or stale. */
export async function refreshReentryNotes(
  db: DatabaseSync, llm: LLMProvider, model: string, projects: ProjectView[],
  opts: { concurrency: number; outDir?: string; now?: number },
): Promise<{ generated: number; failed: { project: ProjectView; error: string }[] }> {
  const due = projects.filter((p) => isEligible(p, opts.now) && !getReentryNote(db, p)?.fresh);
  const result = { generated: 0, failed: [] as { project: ProjectView; error: string }[] };
  await pool(due, opts.concurrency, async (p) => {
    try {
      await generateReentryNote(db, llm, model, p, opts.outDir);
      result.generated++;
    } catch (err) {
      result.failed.push({ project: p, error: (err as Error).message });
    }
  });
  return result;
}
