import { basename, dirname } from 'node:path';
import type { Config } from '../config.ts';
import { localDate } from '../db.ts';
import type { DatabaseSync } from '../fs/guard.ts';
import { discover, isCodeProject, type Candidate } from './discover.ts';
import { gatherFacts, type Facts } from './facts.ts';

export interface ScanResult {
  project: ProjectRow;
  facts: Facts | null;
  error?: string;
}

export interface ProjectRow {
  id: string;
  path: string;
  name: string;
  root: string;
  kind: string;
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

/** Assigns stable ids: existing projects keep theirs, new ones get a slug (parent-qualified on collision). */
function assignIds(db: DatabaseSync, candidates: Candidate[]): Map<string, string> {
  const rows = db.prepare('SELECT id, path FROM projects').all() as { id: string; path: string }[];
  const byPath = new Map(rows.map((r) => [r.path, r.id]));
  const taken = new Set(rows.map((r) => r.id));
  const ids = new Map<string, string>();
  for (const c of candidates) {
    let id = byPath.get(c.path);
    if (!id) {
      id = slugify(c.name);
      if (taken.has(id)) id = `${slugify(basename(dirname(c.path)))}-${id}`;
      for (let n = 2; taken.has(id); n++) id = `${slugify(c.name)}-${n}`;
      taken.add(id);
    }
    ids.set(c.path, id);
  }
  return ids;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runScan(db: DatabaseSync, config: Config, onProgress?: (done: number, total: number) => void): Promise<ScanResult[]> {
  const now = Date.now();
  const scanId = Number(db.prepare('INSERT INTO scans (started_at) VALUES (?)').run(now).lastInsertRowid);
  const candidates = discover(config);
  const ids = assignIds(db, candidates);

  let done = 0;
  const results = await pool(candidates, 6, async (c): Promise<ScanResult> => {
    const project: ProjectRow = { id: ids.get(c.path)!, path: c.path, name: c.name, root: c.root, kind: 'mixed' };
    try {
      const facts = await gatherFacts(c, isCodeProject(c.path), { maxFiles: config.maxFilesPerProject, skipDirs: config.skipDirs }, now);
      project.kind = facts.kind;
      return { project, facts };
    } catch (err) {
      return { project, facts: null, error: (err as Error).message };
    } finally {
      onProgress?.(++done, candidates.length);
    }
  });

  const upsertProject = db.prepare(`
    INSERT INTO projects (id, path, name, root, kind, first_seen, last_seen, missing)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET path = excluded.path, name = excluded.name, root = excluded.root,
      kind = excluded.kind, last_seen = excluded.last_seen, missing = 0`);
  const upsertSnapshot = db.prepare(`
    INSERT OR REPLACE INTO snapshots (project_id, date, taken_at, fingerprint, last_activity_at, commits_30d,
      dirty_count, file_count, size_bytes, todo_count, facts_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE projects SET missing = 1').run();
    const date = localDate(now);
    for (const { project: p, facts: f } of results) {
      upsertProject.run(p.id, p.path, p.name, p.root, p.kind, now, now);
      if (!f) continue;
      upsertSnapshot.run(
        p.id, date, now, f.fingerprint, f.lastActivityAt, f.git?.commits30 ?? null,
        f.git ? f.git.modified + f.git.untracked : null, f.fileCount, f.sizeBytes, f.todoCount, JSON.stringify(f),
      );
    }
    db.prepare('UPDATE scans SET finished_at = ?, project_count = ? WHERE id = ?').run(Date.now(), results.length, scanId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return results;
}
