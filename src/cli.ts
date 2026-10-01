import { scanCommand } from './commands/scan.ts';
import { reportCommand } from './commands/report.ts';
import { projectCommand, statusCommand } from './commands/status.ts';

const HELP = `manager — a quiet studio manager

  scan               discover projects and record today's snapshot
  status [--all]     portfolio at a glance
  project <name>     one project in detail, with its profile
                     [--refresh] re-profile · [--offline] facts only
  report [--force]   profile changed projects, then synthesize the portfolio
  patterns           what your history suggests     (slice 3)
  checkin            a short reflective check-in    (slice 4)
  log "text" [1-5]   journal entry, optional energy (slice 4)
  serve              local dashboard                (slice 5)
`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'scan': return scanCommand();
    case 'status': return statusCommand(args);
    case 'project': return projectCommand(args);
    case 'report': return reportCommand(args);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;
    default:
      if (['patterns', 'checkin', 'log', 'serve'].includes(cmd)) {
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
