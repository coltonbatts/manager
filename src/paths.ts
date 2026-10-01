import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Manager's own directory. Everything outside it is read-only. */
export const ROOT = resolve(import.meta.dirname, '..');

/** The only place Manager ever writes. */
export const DATA_DIR = join(ROOT, 'data');

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function tildify(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}
