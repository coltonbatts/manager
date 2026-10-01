import { openDb } from '../db.ts';
import { findProject } from '../store.ts';
import { localDate } from '../util.ts';
import { dim } from '../ui.ts';

const TYPES = ['shipped', 'paused', 'abandoned', 'active'];

/** manager mark <project> <shipped|paused|abandoned|active> [--date YYYY-MM-DD] [note…] */
export function markCommand(args: string[]): void {
  const dateIdx = args.indexOf('--date');
  const date = dateIdx >= 0 ? args[dateIdx + 1] : localDate();
  const rest = dateIdx >= 0 ? [...args.slice(0, dateIdx), ...args.slice(dateIdx + 2)] : args;
  const typeIdx = rest.findIndex((a) => TYPES.includes(a));
  if (typeIdx <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
    console.log(`Usage: manager mark <project> <${TYPES.join('|')}> [--date YYYY-MM-DD] [note]`);
    return;
  }
  const db = openDb();
  const query = rest.slice(0, typeIdx).join(' ');
  const { match, candidates } = findProject(db, query);
  if (!match) {
    console.log(candidates.length ? `"${query}" is ambiguous: ${candidates.map((c) => c.id).join(', ')}` : `No project matches "${query}".`);
    return;
  }
  const note = rest.slice(typeIdx + 1).join(' ') || null;
  db.prepare('INSERT INTO events (project_id, date, type, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(match.id, date, rest[typeIdx], note, Date.now());
  console.log(`Marked ${match.name} as ${rest[typeIdx]} on ${date}.${note ? dim(` "${note}"`) : ''}`);
}
