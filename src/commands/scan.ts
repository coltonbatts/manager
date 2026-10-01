import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { runScan } from '../scan/scan.ts';
import { stateOf } from '../store.ts';
import { dim, plural } from '../ui.ts';

export async function scanCommand(): Promise<void> {
  const config = loadConfig();
  const db = openDb();
  const started = Date.now();
  const progress = process.stderr.isTTY
    ? (done: number, total: number) => process.stderr.write(`\r${dim(`scanning ${done}/${total}`)}`)
    : undefined;
  const results = await runScan(db, config, { onProgress: progress });
  if (progress) process.stderr.write('\r\x1b[K');

  const counts: Record<string, number> = {};
  for (const r of results) {
    const s = r.facts ? stateOf(r.facts.lastActivityAt) : 'unknown';
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const errors = results.filter((r) => r.error);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Scanned ${plural(results.length, 'project')} in ${secs}s.`);
  console.log(dim(['active', 'warm', 'cooling', 'dormant', 'unknown'].filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(' · ')));
  for (const e of errors) console.log(dim(`  ! ${e.project.name}: ${e.error}`));
  console.log(dim('Run `manager status` to see them.'));
}
