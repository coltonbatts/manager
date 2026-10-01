// Test fixtures live under data/test-tmp and are written through the guard,
// so tests obey the same rule as Manager itself.

import { join } from 'node:path';
import { normalizeConfig } from '../src/config.ts';
import type { DatabaseSync } from '../src/fs/guard.ts';
import { runScan } from '../src/scan/scan.ts';
import { ensureDir, remove, writeText } from '../src/fs/guard.ts';
import { DATA_DIR } from '../src/paths.ts';

// One dir per test process: node --test runs files in parallel.
export const TMP = join(DATA_DIR, 'test-tmp', String(process.pid));

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

/** Scans a fixture root (which lives inside Manager, so discovery's self-exclusion is overridden). */
export function scanFixture(db: DatabaseSync, root: string) {
  return runScan(db, normalizeConfig({ roots: [{ path: root }] }), { self: '/nonexistent-manager-root' });
}
