import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { buildContext, fallbackQuestions, llmQuestions } from '../journal/checkin.ts';
import { correlate, describeCorrelation } from '../journal/correlate.ts';
import { addEntry, allEntries, openJournal, saveCheckin, type Question } from '../journal/journal.ts';
import { createProvider } from '../llm/index.ts';
import { dailyActivity, lastScan } from '../store.ts';
import { ago, bold, dim } from '../ui.ts';

function score(v: string | undefined, flag: string): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error(`${flag} must be a whole number from 1 to 5`);
  return n;
}

/** manager log "text" [energy 1-5] [--mood 1-5] [--energy 1-5]   ·   manager log  (recent entries) */
export function logCommand(args: string[]): void {
  const journal = openJournal();
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const mood = score(flag('--mood'), '--mood');
  let energy = score(flag('--energy'), '--energy');
  if (energy === null && args.length > 1 && /^[1-5]$/.test(args[args.length - 1])) energy = score(args.pop(), 'energy');
  const text = args.join(' ').trim();

  if (!text) {
    showJournal();
    return;
  }
  addEntry(journal, text, energy, mood);
  const scores = [energy !== null && `energy ${energy}`, mood !== null && `mood ${mood}`].filter(Boolean).join(', ');
  console.log(dim(`Logged${scores ? ` (${scores})` : ''}. Stored only in data/journal.db.`));
}

function showJournal(): void {
  const journal = openJournal();
  const entries = allEntries(journal);
  if (!entries.length) {
    console.log('No entries yet. Try: manager log "feeling scattered, too many tabs open" 2');
    return;
  }
  console.log(bold('Journal') + dim(` · ${entries.length} entries`));
  for (const e of entries.slice(0, 12)) {
    const s = [e.energy !== null && `e${e.energy}`, e.mood !== null && `m${e.mood}`].filter(Boolean).join(' ');
    console.log(`  ${dim(ago(e.at).padEnd(8))} ${s ? dim(s.padEnd(6)) : '      '} ${e.text}`);
  }
  printCorrelations();
}

export function printCorrelations(): void {
  const db = openDb();
  const report = correlate(allEntries(openJournal()), dailyActivity(db));
  console.log(`\n${bold('Energy, mood & activity')}`);
  const { energy, mood } = report.scoredDays;
  if (Math.max(energy, mood) < report.minDays) {
    console.log(dim(`  Not enough scored days yet (energy ${energy}, mood ${mood}; need ${report.minDays}). Keep logging with a 1–5 score.`));
    return;
  }
  if (!report.findings.length) {
    console.log(dim(`  No clear relationship in ${report.checked} comparisons. That's a real result too.`));
    return;
  }
  for (const f of report.findings) console.log(`  ${describeCorrelation(f)}`);
  console.log(dim(`  Observations, not diagnoses. ${report.checked} comparisons checked, so expect some to be chance.`));
}

export async function checkinCommand(): Promise<void> {
  const config = loadConfig();
  const db = openDb();
  const journal = openJournal();
  if (!lastScan(db)) console.log(dim('(No scans yet, so questions will be generic. Run `manager scan` for better ones.)'));
  const ctx = buildContext(db, journal, { shareText: config.journal.shareTextWithLLM });

  let questions: Question[];
  let source = 'llm';
  if (process.stderr.isTTY) process.stderr.write(dim('thinking…'));
  try {
    questions = await llmQuestions(createProvider(config.llm), config.llm.reportModel, ctx);
  } catch (err) {
    source = 'fallback';
    questions = fallbackQuestions(ctx);
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
    console.log(dim(`(LLM unavailable, so these come from simple rules: ${(err as Error).message.split('.')[0]})`));
  }
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');

  const w = ctx.week;
  console.log(`\n${bold('Check-in')} ${dim(`· ${ctx.today} · ${w.touched.length} projects touched this week, ${w.commits} commits, ${w.shipped.length} shipped`)}\n`);

  const answers: (string | null)[] = [];
  if (!process.stdin.isTTY) {
    questions.forEach((q, i) => console.log(`${i + 1}. ${q.question}\n   ${dim(q.basis)}\n`));
    saveCheckin(journal, source, questions, questions.map(() => null));
    console.log(dim('Saved the questions. Run in a terminal to answer them.'));
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const [i, q] of questions.entries()) {
      console.log(`${i + 1}. ${q.question}`);
      console.log(dim(`   ${q.basis}`));
      const a = (await rl.question('   › ')).trim();
      answers.push(a || null);
      console.log();
    }
  } finally {
    rl.close();
  }
  saveCheckin(journal, source, questions, answers);
  const answered = answers.filter(Boolean).length;
  console.log(dim(answered ? `Saved ${answered} answer${answered === 1 ? '' : 's'} to your journal. Thanks for being honest with yourself.` : 'Saved. No answers this time, and that\'s fine.'));
}
