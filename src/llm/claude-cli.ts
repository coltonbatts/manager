// LLMProvider backed by Claude Code headless mode: `claude -p --output-format json`.
// Runs with no tools and no MCP servers, from inside data/tmp, with the prompt on stdin.
// The model only ever sees the digest we hand it.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ensureDir } from '../fs/guard.ts';
import { DATA_DIR } from '../paths.ts';
import { checkRequired, LLMError, type LLMCallRecord, type LLMProvider, type LLMRequest } from './provider.ts';

export interface ClaudeCliOptions {
  command: string;
  model: string;
  timeoutSeconds: number;
  /** Called once per finished call with its token usage. Failures here never affect the call. */
  onCall?: (call: LLMCallRecord) => void;
}

interface CliResult {
  type?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  duration_ms?: number;
  modelUsage?: Record<string, {
    inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number;
  }>;
}

/** Token counts and cost from the JSON envelope, or null if the CLI printed no usage. */
export function parseCallUsage(stdout: string): Omit<LLMCallRecord, 'at' | 'task' | 'ok'> | null {
  let envelope: CliResult;
  try { envelope = JSON.parse(stdout) as CliResult; } catch { return null; }
  const entries = Object.entries(envelope.modelUsage ?? {});
  if (!entries.length) return null;
  const sum = (pick: (u: (typeof entries)[number][1]) => number | undefined) => entries.reduce((a, [, u]) => a + (pick(u) ?? 0), 0);
  // If a call touched several models, attribute it to the one that cost the most.
  const [model] = entries.reduce((best, e) => ((e[1].costUSD ?? 0) > (best[1].costUSD ?? 0) ? e : best));
  return {
    model,
    input: sum((u) => u.inputTokens),
    output: sum((u) => u.outputTokens),
    cacheRead: sum((u) => u.cacheReadInputTokens),
    cacheWrite: sum((u) => u.cacheCreationInputTokens),
    costUsd: envelope.total_cost_usd ?? sum((u) => u.costUSD),
    durationMs: envelope.duration_ms ?? 0,
  };
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

  private record(req: LLMRequest, stdout: string, ok: boolean): void {
    if (!this.opts.onCall) return;
    try {
      const usage = parseCallUsage(stdout);
      if (usage) this.opts.onCall({ at: Date.now(), task: req.task, ok, ...usage });
    } catch { /* bookkeeping must never break a call */ }
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
        let outcome: { value: unknown } | { error: unknown };
        try {
          const value = parseCliOutput(stdout);
          checkRequired(value, req.schema);
          outcome = { value };
        } catch (error) {
          outcome = { error };
        }
        this.record(req, stdout, 'value' in outcome);
        if ('value' in outcome) resolve(outcome.value as T);
        else reject(outcome.error);
      });
      child.stdin.end(req.prompt);
    });
  }
}
