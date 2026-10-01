// Cheap, LLM-free facts about one project.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../git.ts';
import { listFiles, readTextSafe, type FileEntry } from '../fs/read.ts';
import type { Candidate } from './discover.ts';

export type Kind = 'code' | 'creative' | 'notes' | 'mixed';

export interface GitFacts {
  branch: string | null;
  head: string | null;
  commitCount: number;
  firstCommitAt: number | null; // ms
  lastCommitAt: number | null; // ms
  commits7: number;
  commits30: number;
  commits90: number;
  modified: number;
  untracked: number;
  hasRemote: boolean;
  tagCount: number;
}

export interface Facts {
  kind: Kind;
  git: GitFacts | null;
  fileCount: number;
  sizeBytes: number;
  newestMtime: number | null;
  touched7: number;
  touched30: number;
  truncated: boolean;
  languages: Record<string, number>; // language -> file count
  stack: string[];
  docs: { readme: boolean; claudeMd: boolean; agentsMd: boolean };
  todoCount: number;
  media: { video: number; image: number; audio: number; design: number };
  lastActivityAt: number | null;
  fingerprint: string;
}

const LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rs: 'Rust', go: 'Go', swift: 'Swift', kt: 'Kotlin', java: 'Java', rb: 'Ruby', php: 'PHP',
  c: 'C', h: 'C', cc: 'C++', cpp: 'C++', hpp: 'C++', cs: 'C#', lua: 'Lua', sh: 'Shell', zsh: 'Shell',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro', sql: 'SQL', zig: 'Zig', dart: 'Dart', m: 'Objective-C',
  mm: 'Objective-C', gd: 'GDScript', glsl: 'GLSL', wgsl: 'WGSL', html: 'HTML', css: 'CSS', scss: 'CSS',
};
const NON_CODE_LANGS = new Set(['HTML', 'CSS']);
const MEDIA: Record<string, keyof Facts['media']> = {};
for (const e of ['mov', 'mp4', 'm4v', 'mxf', 'braw', 'r3d', 'avi', 'mkv', 'webm']) MEDIA[e] = 'video';
for (const e of ['png', 'jpg', 'jpeg', 'heic', 'tif', 'tiff', 'gif', 'webp', 'raw', 'dng', 'cr2', 'cr3', 'arw', 'nef', 'raf', 'exr']) MEDIA[e] = 'image';
for (const e of ['wav', 'mp3', 'aif', 'aiff', 'flac', 'm4a', 'ogg', 'pkf']) MEDIA[e] = 'audio';
for (const e of ['psd', 'psb', 'ai', 'fig', 'sketch', 'xd', 'aep', 'prproj', 'drp', 'blend', 'c4d', 'kra', 'procreate', 'indd', 'afdesign', 'afphoto', 'riv', 'lottie']) MEDIA[e] = 'design';
const DOC_EXT = new Set(['md', 'mdx', 'txt', 'csv', 'pdf', 'docx', 'doc', 'rtf', 'pages', 'numbers', 'xlsx', 'key']);
const TODO_EXT = new Set([...Object.keys(LANG), 'md', 'mdx', 'txt']);
const TODO_RE = /\b(TODO|FIXME)\b/g;

const DAY = 86_400_000;

function ext(rel: string): string {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

async function gitFacts(dir: string, now: number): Promise<GitFacts> {
  const [head, branch, log, status, remote, tags] = await Promise.all([
    git(dir, ['rev-parse', 'HEAD']),
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(dir, ['log', '--format=%ct']),
    git(dir, ['status', '--porcelain=v1']),
    git(dir, ['remote']),
    git(dir, ['tag', '--list']),
  ]);
  const times = (log ?? '').split('\n').filter(Boolean).map((t) => Number(t) * 1000);
  const statusLines = (status ?? '').split('\n').filter(Boolean);
  const within = (days: number) => times.filter((t) => now - t <= days * DAY).length;
  return {
    branch: branch?.trim() || null,
    head: head?.trim() || null,
    commitCount: times.length,
    firstCommitAt: times.length ? Math.min(...times) : null,
    lastCommitAt: times.length ? Math.max(...times) : null,
    commits7: within(7),
    commits30: within(30),
    commits90: within(90),
    modified: statusLines.filter((l) => !l.startsWith('??')).length,
    untracked: statusLines.filter((l) => l.startsWith('??')).length,
    hasRemote: Boolean(remote?.trim()),
    tagCount: (tags ?? '').split('\n').filter(Boolean).length,
  };
}

function detectStack(dir: string): string[] {
  const stack = new Set<string>();
  const has = (f: string) => existsSync(join(dir, f));
  const pkgText = has('package.json') ? readTextSafe(join(dir, 'package.json')) : null;
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { dependencies?: object; devDependencies?: object };
      const deps = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
      const map: [string, string][] = [
        ['next', 'Next.js'], ['react', 'React'], ['vite', 'Vite'], ['remotion', 'Remotion'], ['electron', 'Electron'],
        ['@tauri-apps/api', 'Tauri'], ['svelte', 'Svelte'], ['vue', 'Vue'], ['astro', 'Astro'], ['express', 'Express'],
        ['hono', 'Hono'], ['three', 'Three.js'], ['tailwindcss', 'Tailwind'], ['expo', 'Expo'],
        ['react-native', 'React Native'], ['@anthropic-ai/sdk', 'Anthropic SDK'], ['openai', 'OpenAI SDK'],
        ['@modelcontextprotocol/sdk', 'MCP'], ['typescript', 'TypeScript'], ['stripe', 'Stripe'],
      ];
      for (const [dep, label] of map) if (deps.has(dep)) stack.add(label);
      if (!stack.size) stack.add('Node');
    } catch {
      stack.add('Node');
    }
  }
  if (has('Cargo.toml')) stack.add('Rust');
  if (has('src-tauri')) stack.add('Tauri');
  const py = ['pyproject.toml', 'requirements.txt', 'setup.py'].filter(has);
  if (py.length) {
    stack.add('Python');
    const text = py.map((f) => readTextSafe(join(dir, f)) ?? '').join('\n').toLowerCase();
    for (const [dep, label] of [['fastapi', 'FastAPI'], ['flask', 'Flask'], ['django', 'Django'], ['torch', 'PyTorch'], ['mcp', 'MCP'], ['anthropic', 'Anthropic SDK']]) {
      if (new RegExp(`\\b${dep}\\b`).test(text)) stack.add(label);
    }
  }
  if (has('go.mod')) stack.add('Go');
  if (has('Package.swift')) stack.add('Swift');
  if (has('Gemfile')) stack.add('Ruby');
  if (has('deno.json')) stack.add('Deno');
  if (has('Dockerfile') || has('docker-compose.yml') || has('compose.yaml')) stack.add('Docker');
  if (has('vercel.json') || has('.vercel')) stack.add('Vercel');
  return [...stack];
}

function classify(isCode: boolean, files: FileEntry[], languages: Record<string, number>, media: Facts['media']): Kind {
  const total = files.length || 1;
  const codeFiles = Object.entries(languages).filter(([l]) => !NON_CODE_LANGS.has(l)).reduce((a, [, n]) => a + n, 0);
  if (isCode || codeFiles / total >= 0.2) return 'code';
  const mediaFiles = media.video + media.image + media.audio + media.design;
  if (mediaFiles / total >= 0.3) return 'creative';
  if (files.filter((f) => DOC_EXT.has(ext(f.rel))).length / total >= 0.5) return 'notes';
  return 'mixed';
}

export async function gatherFacts(c: Candidate, isCode: boolean, opts: { maxFiles: number; skipDirs: Set<string> }, now = Date.now()): Promise<Facts> {
  const [gf, list] = await Promise.all([
    c.isGit ? gitFacts(c.path, now) : Promise.resolve(null),
    listFiles(c.path, c.isGit, { maxFiles: opts.maxFiles, skipDirs: opts.skipDirs }),
  ]);
  const files = list.files;

  const languages: Record<string, number> = {};
  const media = { video: 0, image: 0, audio: 0, design: 0 };
  let sizeBytes = 0;
  let newestMtime: number | null = null;
  let touched7 = 0;
  let touched30 = 0;
  for (const f of files) {
    const e = ext(f.rel);
    if (LANG[e]) languages[LANG[e]] = (languages[LANG[e]] ?? 0) + 1;
    if (MEDIA[e]) media[MEDIA[e]]++;
    sizeBytes += f.size;
    if (newestMtime === null || f.mtimeMs > newestMtime) newestMtime = f.mtimeMs;
    if (now - f.mtimeMs <= 7 * DAY) touched7++;
    if (now - f.mtimeMs <= 30 * DAY) touched30++;
  }

  let todoCount = 0;
  let read = 0;
  for (const f of files) {
    if (read >= 5000 || f.size > 512 * 1024 || !TODO_EXT.has(ext(f.rel))) continue;
    read++;
    const text = readTextSafe(join(c.path, f.rel), 512 * 1024);
    if (text) todoCount += text.match(TODO_RE)?.length ?? 0;
  }

  const lower = new Set(files.map((f) => f.rel.toLowerCase()));
  const docs = {
    readme: [...lower].some((r) => /^readme(\.|$)/.test(r)),
    claudeMd: lower.has('claude.md'),
    agentsMd: lower.has('agents.md'),
  };

  // For clean git repos, file mtimes mostly reflect checkouts, so trust the last commit.
  const dirty = gf ? gf.modified + gf.untracked : 0;
  const lastActivityAt = gf && gf.lastCommitAt !== null && dirty === 0
    ? gf.lastCommitAt
    : Math.max(gf?.lastCommitAt ?? 0, newestMtime ?? 0) || null;

  const fingerprint = createHash('sha1')
    .update(JSON.stringify([gf?.head, gf?.modified, gf?.untracked, newestMtime, files.length, sizeBytes]))
    .digest('hex')
    .slice(0, 16);

  return {
    kind: classify(isCode, files, languages, media),
    git: gf,
    fileCount: files.length,
    sizeBytes,
    newestMtime,
    touched7,
    touched30,
    truncated: list.truncated,
    languages,
    stack: detectStack(c.path),
    docs,
    todoCount,
    media,
    lastActivityAt,
    fingerprint,
  };
}
