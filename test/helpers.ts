// Test fixtures live under data/test-tmp and are written through the guard,
// so tests obey the same rule as Manager itself.

import { join } from 'node:path';
import { ensureDir, remove, writeText } from '../src/fs/guard.ts';
import { DATA_DIR } from '../src/paths.ts';

export const TMP = join(DATA_DIR, 'test-tmp');

export function fixture(name: string, files: Record<string, string>): string {
  const dir = join(TMP, name);
  remove(dir);
  ensureDir(dir);
  for (const [rel, content] of Object.entries(files)) writeText(join(dir, rel), content);
  return dir;
}

export function cleanup(): void {
  remove(TMP);
}
