// Read-only filesystem helpers plus the junk and secret rules.
// Secret files are never listed, never read, and never sent to the LLM.

import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { git } from '../git.ts';
import { isIgnored, parseGitignore, type IgnoreRule } from './gitignore.ts';

/** Dependency, build and cache dirs: never walked. */
export const JUNK_DIRS = new Set([
  '.git', 'node_modules', 'bower_components', 'jspm_packages', 'vendor',
  'target', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', '.output', '.astro', '.vercel', '.netlify',
  '.turbo', '.cache', '.parcel-cache', '.vite', '.expo', '.angular', 'coverage', '.nyc_output',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.ipynb_checkpoints',
  '.gradle', 'DerivedData', 'Pods', '.build', '.swiftpm', '.terraform', '.idea', '.Trash',
]);

/** Media caches, render outputs and model weights: heavy and not authored work. */
export const MEDIA_HEAVY_DIRS = new Set([
  'Media Cache', 'Media Cache Files', 'Proxies', 'Proxy', 'CacheClip', '.gallery', 'Render Files', 'Render Cache',
  'Optimized Media', 'Adobe Premiere Pro Preview Files', 'Adobe Premiere Pro Audio Previews',
  'Adobe After Effects Disk Cache', 'models', 'checkpoints', 'ROMs',
]);

const SECRET_NAMES: RegExp[] = [
  /^\.env($|\.)/i,
  /^\.envrc$/i,
  /^\.dev\.vars$/i,
  /\.(pem|key|p8|p12|pfx|jks|keystore|crt|cer|der|gpg|asc|ovpn|kdbx|ppk|mobileprovision)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^(credentials?|secrets?)(\..*)?$/i,
  /^\.(npmrc|pypirc|netrc|pgpass|git-credentials|htpasswd)$/i,
  /service[-_]?account.*\.json$/i,
  /^(token|tokens|auth)\.json$/i,
  /\.secrets?(\..*)?$/i,
];
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.secrets', 'secrets', '.docker']);

export function isSecretName(name: string): boolean {
  return SECRET_NAMES.some((re) => re.test(name));
}

/** True if any path segment is a secret dir, or the file name looks like a secret. */
export function isSecretPath(p: string): boolean {
  const parts = p.split(/[\\/]/);
  return parts.some((s) => SECRET_DIRS.has(s)) || isSecretName(parts[parts.length - 1]);
}

export function isSkippedDir(name: string, extraSkip: Set<string> = new Set()): boolean {
  return JUNK_DIRS.has(name) || MEDIA_HEAVY_DIRS.has(name) || SECRET_DIRS.has(name) || extraSkip.has(name);
}

/** A python virtualenv under any name. */
export function isVenv(dir: string): boolean {
  return existsSync(join(dir, 'pyvenv.cfg'));
}

export class SecretFileError extends Error {
  constructor(p: string) {
    super(`refusing to read secret-like file: ${p}`);
    this.name = 'SecretFileError';
  }
}

/**
 * Reads a small text file. Throws SecretFileError for secret-like paths (checked on both the
 * given path and its symlink target). Returns null for binary, huge or unreadable files.
 */
export function readTextSafe(p: string, maxBytes = 256 * 1024): string | null {
  if (isSecretPath(p)) throw new SecretFileError(p);
  let real: string;
  try { real = realpathSync(p); } catch { return null; }
  if (isSecretPath(real)) throw new SecretFileError(p);
  let fd: number | null = null;
  try {
    const st = lstatSync(real);
    if (!st.isFile() || st.size > maxBytes) return null;
    fd = openSync(real, 'r');
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    if (buf.subarray(0, 8000).includes(0)) return null; // binary
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export interface FileEntry {
  rel: string; // relative to project root, `/` separated
  size: number;
  mtimeMs: number;
}

export interface ListOptions {
  maxFiles?: number;
  skipDirs?: Set<string>;
}

export interface FileList {
  files: FileEntry[];
  truncated: boolean;
}

function keepRel(rel: string, skipDirs: Set<string>): boolean {
  const parts = rel.split('/');
  if (parts.slice(0, -1).some((d) => isSkippedDir(d, skipDirs))) return false;
  return !isSecretPath(rel) && parts[parts.length - 1] !== '.DS_Store';
}

/** Lists a project's files, honoring .gitignore, skipping junk and secrets. Never follows symlinks. */
export async function listFiles(root: string, isGit: boolean, opts: ListOptions = {}): Promise<FileList> {
  const maxFiles = opts.maxFiles ?? 20_000;
  const skipDirs = opts.skipDirs ?? new Set<string>();
  if (isGit) {
    const pathspec = ['.', ...[...JUNK_DIRS].map((d) => `:(exclude,glob)**/${d}/**`)];
    const out = await git(root, ['ls-files', '-z', '-c', '-o', '--exclude-standard', '--', ...pathspec]);
    if (out !== null) {
      const files: FileEntry[] = [];
      const seen = new Set<string>();
      for (const rel of out.split('\0')) {
        if (!rel || seen.has(rel) || !keepRel(rel, skipDirs)) continue;
        seen.add(rel);
        if (files.length >= maxFiles) return { files, truncated: true };
        try {
          const st = lstatSync(join(root, rel));
          if (st.isFile()) files.push({ rel, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* tracked but deleted */ }
      }
      return { files, truncated: false };
    }
  }
  return walk(root, maxFiles, skipDirs);
}

function walk(root: string, maxFiles: number, skipDirs: Set<string>): FileList {
  const files: FileEntry[] = [];
  const stack: { dir: string; rel: string; rules: { base: string; rules: IgnoreRule[] }[] }[] = [
    { dir: root, rel: '', rules: [] },
  ];
  while (stack.length) {
    const { dir, rel, rules: inherited } = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    let rules = inherited;
    if (entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      const text = readTextSafe(join(dir, '.gitignore'));
      if (text) rules = [...inherited, { base: rel, rules: parseGitignore(text) }];
    }
    const ignored = (childRel: string, isDir: boolean) =>
      rules.some((r) => isIgnored(r.rules, r.base ? childRel.slice(r.base.length + 1) : childRel, isDir));
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (isSkippedDir(e.name, skipDirs) || isVenv(abs) || ignored(childRel, true)) continue;
        stack.push({ dir: abs, rel: childRel, rules });
      } else if (e.isFile()) {
        if (e.name === '.DS_Store' || isSecretName(e.name) || ignored(childRel, false)) continue;
        if (files.length >= maxFiles) return { files, truncated: true };
        try {
          const st = lstatSync(abs);
          files.push({ rel: childRel, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* vanished */ }
      }
      // symlinks are deliberately ignored
    }
  }
  return { files, truncated: false };
}

export function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

export function hasEntries(dir: string): boolean {
  try { return readdirSync(dir).some((n) => n !== '.DS_Store'); } catch { return false; }
}

export function exists(p: string): boolean {
  return existsSync(p);
}

export function realpath(p: string): string {
  return realpathSync(p);
}

export function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}
