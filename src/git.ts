// Read-only git access. Only allowlisted subcommands run, and optional locks
// are disabled so commands like `git status` never refresh another repo's index.

import { execFile } from 'node:child_process';

const READ_ONLY = new Set(['rev-parse', 'log', 'status', 'ls-files', 'rev-list', 'remote', 'tag', 'for-each-ref', 'diff']);

const ENV = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
};

/** Runs a read-only git command. Resolves to stdout, or null if git fails. */
export function git(cwd: string, args: string[]): Promise<string | null> {
  if (!READ_ONLY.has(args[0])) throw new Error(`git subcommand not allowed: ${args[0]}`);
  // diff must never run external diff tools or textconv filters configured by the repo.
  if (args[0] === 'diff' && !(args.includes('--no-ext-diff') && args.includes('--no-textconv'))) {
    throw new Error('git diff requires --no-ext-diff and --no-textconv');
  }
  const full = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', cwd, ...args];
  return new Promise((done) => {
    execFile('git', full, { env: ENV, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }, (err, stdout) => {
      done(err ? null : stdout);
    });
  });
}
