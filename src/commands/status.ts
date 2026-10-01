import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { createProvider } from '../llm/index.ts';
import { tildify } from '../paths.ts';
import type { Facts } from '../scan/facts.ts';
import { findProject, lastScan, latestProjects, type ProjectView, type State } from '../store.ts';
import { generateProfile, getProfile, type StoredProfile } from '../understand/profile.ts';
import { ago, bold, bytes, dim, pad, plural } from '../ui.ts';

const ORDER: State[] = ['active', 'warm', 'cooling', 'dormant', 'unknown'];
const LABEL: Record<State, string> = {
  active: 'Active · last 7 days',
  warm: 'Warm · last 30 days',
  cooling: 'Cooling · 1–3 months',
  dormant: 'Dormant · 3+ months',
  unknown: 'Empty or no history',
};

function topLanguages(f: Facts, n = 2): string[] {
  return Object.entries(f.languages).sort((a, b) => b[1] - a[1]).slice(0, n).map(([l]) => l);
}

function shortStack(p: ProjectView): string {
  const s = p.facts.stack.filter((x) => x !== 'TypeScript').slice(0, 2);
  if (s.length) return s.join(', ');
  if (p.kind === 'code') return topLanguages(p.facts).join(', ') || 'code';
  return p.kind;
}

function signal(f: Facts): string {
  const bits: string[] = [];
  if (!f.fileCount) return 'empty';
  if (f.git) {
    if (f.git.commits30) bits.push(`${f.git.commits30} commits/30d`);
    const dirty = f.git.modified + f.git.untracked;
    if (dirty) bits.push(`${dirty} uncommitted`);
    if (!f.git.commitCount) bits.push('no commits');
  } else if (f.touched30) {
    bits.push(`${plural(f.touched30, 'file')} touched/30d`);
  }
  return bits.join(' · ');
}

export function statusCommand(args: string[]): void {
  const db = openDb();
  const scan = lastScan(db);
  if (!scan) {
    console.log('No scans yet. Run `manager scan` first.');
    return;
  }
  const showAll = args.includes('--all');
  const projects = latestProjects(db);
  const nameWidth = Math.min(28, Math.max(...projects.map((p) => p.name.length)));

  console.log(dim(`${plural(projects.length, 'project')} · scanned ${ago(scan.finishedAt)}`));
  for (const state of ORDER) {
    const group = projects.filter((p) => p.state === state);
    if (!group.length) continue;
    console.log(`\n${bold(LABEL[state])} ${dim(`(${group.length})`)}`);
    const limit = showAll || state === 'active' || state === 'warm' ? group.length : 8;
    for (const p of group.slice(0, limit)) {
      console.log(`  ${pad(p.name, nameWidth)}  ${dim(pad(ago(p.facts.lastActivityAt), 8))}  ${pad(shortStack(p), 20)}  ${dim(signal(p.facts))}`);
    }
    if (group.length > limit) console.log(dim(`  … ${group.length - limit} more (manager status --all)`));
  }
}

export async function projectCommand(args: string[]): Promise<void> {
  const refresh = args.includes('--refresh');
  const offline = args.includes('--offline');
  const query = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!query) {
    console.log('Usage: manager project <name>');
    return;
  }
  const db = openDb();
  const { match, candidates } = findProject(db, query);
  if (!match) {
    console.log(candidates.length ? `"${query}" matches several projects:` : `No project matches "${query}".`);
    for (const c of candidates.slice(0, 12)) console.log(`  ${c.id}  ${dim(tildify(c.path))}`);
    return;
  }
  const p = match;
  const f = p.facts;
  const line = (k: string, v: string) => console.log(`  ${dim(pad(k, 12))}${v}`);
  console.log(`\n${bold(p.name)}  ${dim(p.state)}`);
  console.log(dim(`  ${tildify(p.path)}\n`));

  let stored: StoredProfile | null = getProfile(db, p);
  if (!offline && (refresh || !stored?.fresh)) {
    const config = loadConfig();
    if (process.stderr.isTTY) process.stderr.write(dim('  profiling…'));
    try {
      stored = await generateProfile(db, createProvider(config.llm), config.llm.model, p);
    } catch (err) {
      if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
      console.log(dim(`  (profile unavailable: ${(err as Error).message})\n`));
    }
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  }
  if (stored) {
    const pr = stored.profile;
    console.log(`  ${pr.summary}\n`);
    console.log(`  ${dim('now')}   ${pr.currentState}`);
    console.log(`  ${dim('next')}  ${pr.nextStep}`);
    for (const r of pr.risks) console.log(`  ${dim('risk')}  ${r}`);
    console.log(dim(`\n  ${pr.category} · ${pr.stage} · ${pr.closeness} · ${pr.confidence} confidence · profiled ${ago(stored.generatedAt)}${stored.fresh ? '' : ' (stale)'}\n`));
  }

  line('kind', p.kind);
  if (f.stack.length) line('stack', f.stack.join(', '));
  const langs = topLanguages(f, 4);
  if (langs.length) line('languages', langs.join(', '));
  line('last active', ago(f.lastActivityAt));
  if (f.git) {
    line('branch', `${f.git.branch ?? '—'}${f.git.hasRemote ? '' : dim('  (no remote)')}`);
    line('commits', `${f.git.commitCount} total · ${f.git.commits7} this week · ${f.git.commits30} this month`);
    if (f.git.firstCommitAt) line('started', ago(f.git.firstCommitAt));
    line('uncommitted', `${f.git.modified} modified · ${f.git.untracked} untracked`);
    if (f.git.tagCount) line('tags', String(f.git.tagCount));
  }
  line('files', `${f.fileCount}${f.truncated ? '+' : ''} · ${bytes(f.sizeBytes)} · ${f.touched7} touched this week`);
  const m = f.media;
  const mediaBits = Object.entries(m).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`);
  if (mediaBits.length) line('media', mediaBits.join(' · '));
  const docs = [f.docs.readme && 'README', f.docs.claudeMd && 'CLAUDE.md', f.docs.agentsMd && 'AGENTS.md'].filter(Boolean);
  line('docs', docs.length ? docs.join(', ') : dim('none'));
  line('TODO/FIXME', String(f.todoCount));
  console.log();
}
