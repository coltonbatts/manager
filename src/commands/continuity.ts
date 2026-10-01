import { loadConfig, modelFor } from '../config.ts';
import { openDb } from '../db.ts';
import { createProvider } from '../llm/index.ts';
import { findProject, latestProjects, type ProjectView } from '../store.ts';
import { checkPriorArt, getPriorArt, type PriorArt } from '../understand/prior-art.ts';
import { generateReentryNote, getReentryNote, type ReentryNote } from '../understand/reentry.ts';
import { ago, bold, dim } from '../ui.ts';

function pick(query: string): { db: ReturnType<typeof openDb>; p: ProjectView } | null {
  const db = openDb();
  const { match, candidates } = findProject(db, query);
  if (!match) {
    console.log(candidates.length ? `"${query}" matches several projects: ${candidates.map((c) => c.id).join(', ')}` : `No project matches "${query}".`);
    return null;
  }
  return { db, p: match };
}

export function printNote(n: ReentryNote, at: number, fresh: boolean): void {
  console.log(`  ${n.lastSession}\n`);
  for (const x of n.inFlight) console.log(`  ${dim('in flight')}  ${x}`);
  console.log(`\n  ${bold('First step')}  ${n.firstStep}`);
  for (const x of n.remember) console.log(`  ${dim('remember')}   ${x}`);
  console.log(dim(`\n  ${n.confidence} confidence · written ${ago(at)}${fresh ? '' : ' · project changed since'}\n`));
}

export function printPriorArt(r: PriorArt): void {
  if (!r.related.length) {
    console.log(dim('  Nothing you\'ve built before looks like this. A genuinely new direction.\n'));
    return;
  }
  console.log(`  ${r.headline}\n`);
  for (const x of r.related) {
    console.log(`  ${bold(x.project)}  ${dim(`${x.relation} · ${x.reached}`)}`);
    for (const u of x.reuse) console.log(`    ${u.path}  ${dim(u.why)}`);
  }
  console.log(`\n  ${r.advice}\n`);
}

/** manager resume <project> [--refresh] */
export async function resumeCommand(args: string[]): Promise<void> {
  const query = args.filter((a) => !a.startsWith('--')).join(' ');
  if (!query) return void console.log('Usage: manager resume <project> [--refresh]');
  const found = pick(query);
  if (!found) return;
  const { db, p } = found;
  console.log(`\n${bold(`Where you left off: ${p.name}`)}\n`);
  let stored = getReentryNote(db, p);
  if (!stored?.fresh || args.includes('--refresh')) {
    const config = loadConfig();
    if (process.stderr.isTTY) process.stderr.write(dim('  reading your last session…'));
    stored = await generateReentryNote(db, createProvider(config.llm, db), modelFor(config.llm, 'reentry'), p);
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  }
  printNote(stored.note, stored.generatedAt, stored.fresh);
}

/** manager similar <project> [--refresh] */
export async function similarCommand(args: string[]): Promise<void> {
  const query = args.filter((a) => !a.startsWith('--')).join(' ');
  if (!query) return void console.log('Usage: manager similar <project> [--refresh]');
  const found = pick(query);
  if (!found) return;
  const { db, p } = found;
  console.log(`\n${bold(`Have you built ${p.name} before?`)}\n`);
  let r = getPriorArt(db, p.id)?.result;
  if (!r || args.includes('--refresh')) {
    const config = loadConfig();
    if (process.stderr.isTTY) process.stderr.write(dim('  checking your other projects…'));
    r = await checkPriorArt(db, createProvider(config.llm, db), modelFor(config.llm, 'prior-art'), p, latestProjects(db), modelFor(config.llm, 'prior-art-scan'));
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
  }
  printPriorArt(r);
}
