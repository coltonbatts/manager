import { scanCommand } from './commands/scan.ts';
import { checkinCommand, logCommand } from './commands/journal.ts';
import { markCommand } from './commands/mark.ts';
import { patternsCommand } from './commands/patterns.ts';
import { reportCommand } from './commands/report.ts';
import { projectCommand, statusCommand } from './commands/status.ts';

const HELP = `manager — a quiet studio manager

  scan               discover projects and record today's snapshot
  status [--all]     portfolio at a glance
  project <name>     one project in detail, with its profile
                     [--refresh] re-profile · [--offline] facts only
  report [--force]   profile changed projects, then synthesize the portfolio
  patterns           what your history suggests (metrics + hypotheses)
                     [--no-llm] metrics only · [--force] re-run hypotheses
  mark <project> <shipped|paused|abandoned|active> [--date YYYY-MM-DD] [note]
  checkin            a short reflective check-in (2–4 questions from your data)
  log "text" [1-5]   journal entry; trailing number = energy · [--mood 1-5]
  log                recent entries + energy/mood vs. activity
  serve              local dashboard                (slice 5)
`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'scan': return scanCommand();
    case 'status': return statusCommand(args);
    case 'project': return projectCommand(args);
    case 'report': return reportCommand(args);
    case 'patterns': return patternsCommand(args);
    case 'mark': return markCommand(args);
    case 'log': return logCommand(args);
    case 'checkin': return checkinCommand();
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      if (['serve'].includes(cmd)) {
        console.log(`\`manager ${cmd}\` isn't built yet.`);
        return;
      }
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});
