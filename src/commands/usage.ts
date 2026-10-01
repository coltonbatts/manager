import { loadConfig } from '../config.ts';
import { openDb } from '../db.ts';
import { elapsedFraction, latestLimits, refreshLimits, type Limit } from '../usage/limits.ts';
import { syncTranscripts, usageByDay, usageByProject } from '../usage/transcripts.ts';
import { ago, bold, dim } from '../ui.ts';

export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

function meter(l: Limit, width = 30): string {
  const filled = Math.round((Math.min(l.percent, 100) / 100) * width);
  const pace = elapsedFraction(l);
  const tick = pace === null ? -1 : Math.min(width - 1, Math.round(pace * width));
  let bar = '';
  for (let i = 0; i < width; i++) bar += i === tick ? '│' : i < filled ? '█' : dim('·');
  return bar;
}

export async function usageCommand(): Promise<void> {
  const config = loadConfig();
  const db = openDb();

  let limits = null as Limit[] | null;
  let at = Date.now();
  try {
    limits = await refreshLimits(db, config.llm.command);
  } catch (err) {
    const last = latestLimits(db);
    if (last) { limits = last.limits; at = last.at; }
    console.log(dim(`(live limits unavailable: ${(err as Error).message})`));
  }
  if (limits?.length) {
    console.log(bold('Plan limits') + dim(` · ${ago(at)}`));
    for (const l of limits) {
      const pace = elapsedFraction(l);
      const note = pace === null ? '' : l.percent / 100 > pace + 0.1 ? '  ahead of pace' : '';
      console.log(`  ${l.label.padEnd(20)} ${meter(l)} ${String(Math.round(l.percent)).padStart(3)}%${dim(l.resetsText ? `  resets ${l.resetsText}` : '')}${note}`);
    }
    console.log(dim('  │ marks how far into the window you are. Fill past it means you are using faster than an even pace.'));
  }

  const { files, parsed } = await syncTranscripts(db, config.usage.transcriptsDir);
  const days = usageByDay(db, 14);
  const max = Math.max(1, ...days.map((d) => d.requests));
  console.log(`\n${bold('Requests per day')} ${dim(`· last 14 days · ${files} transcripts, ${parsed} re-read`)}`);
  for (const d of days) {
    const w = Math.round((d.requests / max) * 30);
    console.log(`  ${dim(d.date.slice(5))}  ${'█'.repeat(w)}${dim(w ? '' : '·')} ${d.requests ? `${d.requests} ${dim(`· ${compact(d.output)} out`)}` : ''}`);
  }
  const projects = usageByProject(db, 7);
  if (projects.length) {
    console.log(`\n${bold('Where it went')} ${dim('· last 7 days, by working folder')}`);
    for (const p of projects) console.log(`  ${String(p.requests).padStart(5)}  ${p.project}`);
  }
  console.log(dim('\nToken counts come from local Claude Code transcripts on this machine (not claude.ai or other devices). Only numbers are read.'));
}
