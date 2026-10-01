// Builds the compact, secret-free text the LLM sees for one project.
// The model never touches the filesystem; this digest is all it knows.

import { join } from 'node:path';
import { git } from '../git.ts';
import { isSecretPath, listFiles, readTextSafe, type FileEntry } from '../fs/read.ts';
import { tildify } from '../paths.ts';
import type { ProjectView } from '../store.ts';
import { redact } from './redact.ts';

const MAX_DIGEST = 14_000;
const NOTE_FILES = ['HANDOFF.md', 'TODO.md', 'ROADMAP.md', 'NOTES.md', 'PLAN.md', 'STATUS.md', 'CHANGELOG.md'];

const day = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 10) : 'n/a');

function excerpt(dir: string, rel: string, max: number): string | null {
  try {
    const text = readTextSafe(join(dir, rel));
    if (!text?.trim()) return null;
    return text.length > max ? text.slice(0, max) + '\n…(truncated)' : text;
  } catch {
    return null; // secret-like: skip silently
  }
}

function findFile(files: FileEntry[], name: string): string | undefined {
  return files.find((f) => f.rel.toLowerCase() === name.toLowerCase())?.rel;
}

function tree(files: FileEntry[], maxEntries = 70): string {
  const entries = new Map<string, number>();
  for (const f of files) {
    const parts = f.rel.split('/');
    const key = parts.length === 1 ? parts[0] : parts.length === 2 ? `${parts[0]}/${parts[1]}` : `${parts[0]}/${parts[1]}/…`;
    entries.set(key, (entries.get(key) ?? 0) + 1);
  }
  const lines = [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => (k.endsWith('…') ? `${k} (${n} files)` : k));
  return lines.length > maxEntries ? [...lines.slice(0, maxEntries), `… ${lines.length - maxEntries} more`].join('\n') : lines.join('\n');
}

export async function buildDigest(p: ProjectView): Promise<string> {
  const f = p.facts;
  const { files } = await listFiles(p.path, f.git !== null, { maxFiles: 5000 });
  const out: string[] = [];
  const section = (title: string, body: string | null | undefined) => {
    if (body?.trim()) out.push(`## ${title}\n${body.trim()}`);
  };

  section('Project', [
    `name: ${p.name}`,
    `path: ${tildify(p.path)}`,
    `kind: ${p.kind}   activity state: ${p.state}   last activity: ${day(f.lastActivityAt)}   today: ${day(Date.now())}`,
    f.stack.length ? `stack: ${f.stack.join(', ')}` : null,
    Object.keys(f.languages).length ? `languages (files): ${Object.entries(f.languages).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, n]) => `${l} ${n}`).join(', ')}` : null,
    `files: ${f.fileCount}${f.truncated ? '+' : ''}, touched in last 7d: ${f.touched7}, last 30d: ${f.touched30}`,
    `media files: video ${f.media.video}, image ${f.media.image}, audio ${f.media.audio}, design ${f.media.design}`,
    `TODO/FIXME markers: ${f.todoCount}`,
  ].filter(Boolean).join('\n'));

  if (f.git) {
    const g = f.git;
    section('Git', [
      `branch: ${g.branch ?? 'none'}   remote: ${g.hasRemote ? 'yes' : 'no'}   tags: ${g.tagCount}`,
      `commits: ${g.commitCount} total, ${g.commits7} last 7d, ${g.commits30} last 30d, ${g.commits90} last 90d`,
      `first commit: ${day(g.firstCommitAt)}   last commit: ${day(g.lastCommitAt)}`,
      `uncommitted: ${g.modified} modified, ${g.untracked} untracked`,
    ].join('\n'));
    const log = await git(p.path, ['log', '-n', '30', '--format=%cs %s']);
    section('Recent commits (newest first)', log);
    const status = await git(p.path, ['status', '--porcelain=v1']);
    const changed = (status ?? '').split('\n').filter(Boolean).map((l) => l.slice(3)).filter((r) => !isSecretPath(r));
    if (changed.length) section('Uncommitted paths', changed.slice(0, 30).join('\n') + (changed.length > 30 ? `\n… ${changed.length - 30} more` : ''));
  }

  const recent = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 15);
  section('Most recently modified files', recent.map((r) => `${day(r.mtimeMs)}  ${r.rel}`).join('\n'));
  section('File tree (2 levels)', tree(files));

  const pkg = findFile(files, 'package.json');
  if (pkg) {
    try {
      const j = JSON.parse(readTextSafe(join(p.path, pkg)) ?? '{}') as { name?: string; description?: string; scripts?: Record<string, string> };
      section('package.json', [j.name && `name: ${j.name}`, j.description && `description: ${j.description}`, j.scripts && `scripts: ${Object.keys(j.scripts).join(', ')}`].filter(Boolean).join('\n'));
    } catch { /* malformed */ }
  }

  const readme = files.find((x) => /^readme(\.[a-z]+)?$/i.test(x.rel))?.rel;
  if (readme) section(readme, excerpt(p.path, readme, 3500));
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const rel = findFile(files, name);
    if (rel) section(rel, excerpt(p.path, rel, 2000));
  }
  for (const name of NOTE_FILES) {
    const rel = findFile(files, name);
    if (rel) section(rel, excerpt(p.path, rel, 1500));
  }

  const digest = redact(out.join('\n\n'));
  return digest.length > MAX_DIGEST ? digest.slice(0, MAX_DIGEST) + '\n…(digest truncated)' : digest;
}
