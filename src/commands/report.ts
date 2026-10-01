import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { createProvider } from '../llm/index.ts';
import { lastScan, latestProjects } from '../store.ts';
import { synthesizePortfolio, type PortfolioReport } from '../understand/portfolio.ts';
import { refreshProfiles } from '../understand/profile.ts';
import { ago, bold, dim } from '../ui.ts';

export async function reportCommand(args: string[]): Promise<void> {
  const force = args.includes('--force');
  const config = loadConfig();
  const db = openDb();
  if (!lastScan(db)) {
    console.log('No scans yet. Run `manager scan` first.');
    return;
  }
  const llm = createProvider(config.llm);
  const projects = latestProjects(db);

  const progress = process.stderr.isTTY
    ? (done: number, total: number, p: { name: string }) => process.stderr.write(`\r\x1b[K${dim(`profiling ${done}/${total} · ${p.name}`)}`)
    : undefined;
  const r = await refreshProfiles(db, llm, config.llm.model, projects, { force, concurrency: config.llm.concurrency, onProgress: progress });
  if (progress) process.stderr.write('\r\x1b[K');
  if (r.generated || r.failed.length) console.log(dim(`profiles: ${r.generated} new · ${r.cached} cached${r.failed.length ? ` · ${r.failed.length} failed` : ''}`));
  for (const f of r.failed.slice(0, 5)) console.log(dim(`  ! ${f.project.name}: ${f.error}`));
  if (r.failed.length && !r.generated && !r.cached) {
    console.log('\nNo profiles available, so no portfolio report. Fix the error above and retry.');
    process.exitCode = 1;
    return;
  }

  if (progress) process.stderr.write(dim('synthesizing portfolio…'));
  const { report, generatedAt, cached } = await synthesizePortfolio(db, llm, config.llm.reportModel, projects, force);
  if (progress) process.stderr.write('\r\x1b[K');
  printReport(report, generatedAt, cached);
}

function printReport(r: PortfolioReport, generatedAt: number, cached: boolean): void {
  const group = (title: string, items: { project: string; note: string }[]) => {
    if (!items.length) return;
    console.log(`\n${bold(title)}`);
    for (const i of items) console.log(`  ${i.project}  ${dim('·')} ${i.note}`);
  };
  console.log(`\n${r.headline}`);
  console.log(dim(`generated ${ago(generatedAt)}${cached ? ' · nothing changed since' : ''}`));
  group('Moving', r.active);
  group('Close to shipping', r.closeToShipping);
  group('Stalled', r.stalled);
  group('Quietly abandoned', r.quietlyAbandoned);
  if (r.overlaps.length) {
    console.log(`\n${bold('Overlaps')}`);
    for (const o of r.overlaps) console.log(`  ${o.projects.join(' · ')}  ${dim('·')} ${o.note}`);
  }
  if (r.observations.length) {
    console.log(`\n${bold('Observations')}`);
    for (const o of r.observations) console.log(`  ${o}`);
  }
  console.log(`\n${bold('If you pick one thing')}\n  ${r.suggestedFocus.project}  ${dim('·')} ${r.suggestedFocus.why}\n`);
}
