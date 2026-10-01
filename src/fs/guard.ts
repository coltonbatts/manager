// The write guard. This is the ONLY module in Manager allowed to import
// filesystem write APIs or open a database. Every write resolves the real
// target (following symlinks and `..`) and is refused unless it lands strictly
// inside DATA_DIR. test/guard.test.ts enforces both properties.

import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../paths.ts';

export class WriteGuardError extends Error {
  constructor(target: string, reason = 'outside Manager data directory') {
    super(`write refused (${reason}): ${target}`);
    this.name = 'WriteGuardError';
  }
}

let realDataDir: string | null = null;

function dataRoot(): string {
  if (realDataDir) return realDataDir;
  try {
    if (lstatSync(DATA_DIR).isSymbolicLink()) throw new WriteGuardError(DATA_DIR, 'data dir is a symlink');
  } catch (err) {
    if (err instanceof WriteGuardError) throw err;
    mkdirSync(DATA_DIR); // DATA_DIR is a constant inside ROOT; creating it is the one bootstrap write.
  }
  realDataDir = realpathSync(DATA_DIR);
  return realDataDir;
}

/** Resolve a path to its real location, even if the leaf (or several parents) don't exist yet. */
function resolveReal(target: string): string {
  if (target.includes('\0')) throw new WriteGuardError(target, 'null byte');
  let p = resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(p);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      // A path that lstat sees but realpath can't resolve is a dangling symlink: refuse.
      let dangling = false;
      try { lstatSync(p); dangling = true; } catch { /* genuinely missing */ }
      if (dangling) throw new WriteGuardError(target, 'dangling symlink');
      const parent = dirname(p);
      if (parent === p) throw new WriteGuardError(target, 'unresolvable');
      tail.push(basename(p));
      p = parent;
    }
  }
}

/** Throws unless `target` resolves to a path strictly inside DATA_DIR. Returns the real path. */
export function assertWritable(target: string, { allowDataRoot = false } = {}): string {
  const real = resolveReal(target);
  const rel = relative(dataRoot(), real);
  const outside = rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel);
  if (outside || (rel === '' && !allowDataRoot)) throw new WriteGuardError(target);
  return real;
}

export function ensureDir(target: string): string {
  const real = assertWritable(target, { allowDataRoot: true });
  mkdirSync(real, { recursive: true });
  return real;
}

/** Atomic text write (temp file + rename), both inside DATA_DIR. */
export function writeText(target: string, content: string): void {
  const real = assertWritable(target);
  mkdirSync(dirname(real), { recursive: true });
  const tmp = assertWritable(`${real}.${process.pid}.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, real);
}

export function writeJson(target: string, value: unknown): void {
  writeText(target, JSON.stringify(value, null, 2) + '\n');
}

export function appendText(target: string, content: string): void {
  const real = assertWritable(target);
  mkdirSync(dirname(real), { recursive: true });
  appendFileSync(real, content);
}

export function remove(target: string): void {
  rmSync(assertWritable(target), { recursive: true, force: true });
}

export function openDatabase(file: string): DatabaseSync {
  const real = assertWritable(file);
  mkdirSync(dirname(real), { recursive: true });
  return new DatabaseSync(real);
}

export type { DatabaseSync };
