import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { createProvider } from '../llm/index.ts';
import { formHypotheses } from '../patterns/hypotheses.ts';
import { computePatterns, loadHistories, snapshotDays, type Patterns } from '../patterns/metrics.ts';
import { lastScan, latestProjects } from '../store.ts';
import { ago, bold, dim, plural } from '../ui.ts';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const BARS = ' ▁▂▃▄▅▆▇█';

function spark(xs: number[]): string {
  const max = Math.max(...xs, 1);
  return xs.map((x) => BARS[Math.round((x / max) * 8)]).join('');
}

export function printMetrics(p: Patterns): void {
  const c = p.coverage;
  console.log(dim(`Based on ${plural(c.commits, 'commit')} of yours across ${c.gitProjects} repos plus ${c.fileProjects} non-git folders, since ${c.firstDate ?? '—'}.`));
  console.log(dim('An "active day" is a day with one of your commits or a file modified. File dates only keep the latest edit, so older activity is undercounted.'));
  console.log(dim(`Excluded: ${c.foreignExcluded} clones of other people's repos, ${c.noHistory} with no dated history. Snapshots so far: ${plural(c.snapshotDays, 'day')}.`));

  const b = p.breadth;
  console.log(`\n${bold('Breadth')}  ${dim('projects touched per week, last 26 weeks')}`);
  console.log(`  ${spark(b.weeks.map((w) => w.projects))}`);
  console.log(`  Active in ${b.activeWeeks}/26 weeks. In those weeks, a median of ${b.medianPerActiveWeek} projects. Last 4 weeks averaged ${b.recent4}; the 22 before averaged ${b.prior}.`);

  const s = p.startsVsFinishes;
  console.log(`\n${bold('Starts vs. finishes')}  ${dim('last 12 months')}`);
  console.log(`  started ${spark(s.months.map((m) => m.started))}  ${s.started}`);
  console.log(`  shipped ${spark(s.months.map((m) => m.shipped))}  ${s.shipped}`);
  console.log(dim('  "shipped" = a release tag, a launch-like commit, or `manager mark <project> shipped`. Likely an undercount.'));

  const l = p.lifespan;
  console.log(`\n${bold('Lifespan')}  ${dim(`projects quiet for 30+ days, n=${l.n}`)}`);
  console.log(`  Median span from first to last activity: ${l.medianSpanDays} days, over a median of ${l.medianActiveDays} active days.`);
  console.log(`  ${Object.entries(l.buckets).map(([k, v]) => `${k}: ${v}`).join(dim(' · '))}`);
  console.log(`  ${p.oneBurst.count} of ${p.oneBurst.n} projects (${pct(p.oneBurst.count / (p.oneBurst.n || 1))}) got 3 or fewer active days in total.`);

  const a = p.attention;
  console.log(`\n${bold('Attention')}  ${dim('active days, last 90 days')}`);
  for (const r of a.projects) console.log(`  ${String(r.activeDays).padStart(3)}  ${r.name}`);
  if (a.projects.length) console.log(dim(`  Top project took ${pct(a.top1Share)} of active days; top three took ${pct(a.top3Share)}.`));

  const st = p.stallPoint;
  console.log(`\n${bold('Where things stop')}  ${dim(`${st.quiet} quiet projects, ${st.profiled} profiled`)}`);
  if (st.profiled) {
    console.log(`  stage when they went quiet: ${Object.entries(st.byStage).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(dim(' · '))}`);
    if (Object.keys(st.byCloseness).length) console.log(`  closeness to shipping: ${Object.entries(st.byCloseness).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(dim(' · '))}`);
  } else {
    console.log(dim('  Run `manager report` to profile projects; this section needs profiles.'));
  }
  console.log(`  ${st.quietWithShipEvidence} of ${st.quiet} quiet projects show any ship evidence.`);
  console.log(`  ${p.revivals.revived} of ${p.revivals.gaps} quiet spells ended in a revival.`);

  const w = p.weekdays;
  console.log(`\n${bold('Rhythm')}  ${dim(`commit days by weekday, n=${w.n}`)}`);
  console.log(`  ${WEEKDAYS.map((d, i) => `${d} ${w.counts[i]}`).join(dim(' · '))}`);
}

export async function patternsCommand(args: string[]): Promise<void> {
  const db = openDb();
  if (!lastScan(db)) {
    console.log('No scans yet. Run `manager scan` first.');
    return;
  }
  const { histories, foreign, noHistory } = loadHistories(db, latestProjects(db));
  const patterns = computePatterns(histories, { foreign, noHistory, snapshotDays: snapshotDays(db) });
  printMetrics(patterns);
  if (args.includes('--no-llm')) return;

  const config = loadConfig();
  if (process.stderr.isTTY) process.stderr.write(dim('\nforming hypotheses…'));
  try {
    const { report, generatedAt, cached } = await formHypotheses(db, createProvider(config.llm), config.llm.reportModel, patterns, args.includes('--force'));
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
    console.log(`\n${bold('Hypotheses')}  ${dim(`${ago(generatedAt)}${cached ? ', metrics unchanged since' : ''}`)}`);
    report.hypotheses.forEach((h, i) => {
      console.log(`\n  ${i + 1}. ${h.claim}  ${dim(`${h.confidence} confidence · n=${h.n}`)}`);
      for (const e of h.evidence) console.log(dim(`     · ${e}`));
      console.log(dim(`     or: ${h.alternative}`));
      console.log(dim(`     would change with: ${h.wouldChangeMyMind}`));
    });
    console.log(dim(`\n  ${report.dataCaveat}\n`));
  } catch (err) {
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
    console.log(dim(`\n(hypotheses unavailable: ${(err as Error).message})`));
  }
}
