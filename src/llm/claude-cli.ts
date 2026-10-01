// LLMProvider backed by Claude Code headless mode: `claude -p --output-format json`.
// Runs with no tools and no MCP servers, from inside data/tmp, with the prompt on stdin.
// The model only ever sees the digest we hand it.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ensureDir } from '../fs/guard.ts';
import { DATA_DIR } from '../paths.ts';
import { checkRequired, LLMError, type LLMProvider, type LLMRequest } from './provider.ts';

export interface ClaudeCliOptions {
  command: string;
  model: string;
  timeoutSeconds: number;
}

interface CliResult {
  type?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
}

export function parseCliOutput(stdout: string): unknown {
  let envelope: CliResult;
  try {
    envelope = JSON.parse(stdout) as CliResult;
  } catch {
    throw new LLMError(`claude -p returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  if (envelope.is_error) throw new LLMError(`claude -p reported an error: ${String(envelope.result).slice(0, 300)}`);
  if (envelope.structured_output !== undefined) return envelope.structured_output;
  const text = (envelope.result ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new LLMError(`claude -p answer contained no JSON: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new LLMError(`claude -p answer was not valid JSON: ${text.slice(0, 200)}`);
  }
}

export class ClaudeCliProvider implements LLMProvider {
  readonly name = 'claude-cli';
  private opts: ClaudeCliOptions;

  constructor(opts: ClaudeCliOptions) {
    this.opts = opts;
  }

  complete<T>(req: LLMRequest): Promise<T> {
    const cwd = ensureDir(join(DATA_DIR, 'tmp'));
    const system = `${req.system}\n\nRespond with a single JSON object that matches this JSON Schema, and nothing else:\n${JSON.stringify(req.schema)}`;
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', req.model ?? this.opts.model,
      '--tools', '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--system-prompt', system,
      '--json-schema', JSON.stringify(req.schema),
    ];
    const env = { ...process.env };
    delete env.CLAUDECODE; // allow running from inside a Claude Code session

    return new Promise<T>((resolve, reject) => {
      const child = spawn(this.opts.command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new LLMError(
          `claude -p timed out after ${this.opts.timeoutSeconds}s. If this keeps happening, check that the CLI is logged in: run \`claude\` in a terminal and use /login.`,
        ));
      }, this.opts.timeoutSeconds * 1000);
      child.stdout.on('data', (d: Buffer) => { stdout += d; });
      child.stderr.on('data', (d: Buffer) => { stderr += d; });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new LLMError(`could not run \`${this.opts.command}\`: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && !stdout.trim()) {
          reject(new LLMError(`claude -p exited with code ${code}: ${stderr.trim().slice(0, 300)}`));
          return;
        }
        try {
          const value = parseCliOutput(stdout);
          checkRequired(value, req.schema);
          resolve(value as T);
        } catch (err) {
          reject(err);
        }
      });
      child.stdin.end(req.prompt);
    });
  }
}
