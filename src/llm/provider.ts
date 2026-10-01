// The intelligence boundary. Everything that wants an LLM goes through this
// interface, so the `claude -p` implementation can be swapped later.

/** Every kind of LLM call Manager makes. Each can be routed to its own model (see config `llm.models`). */
export const LLM_TASKS = ['profile', 'reentry', 'prior-art-scan', 'prior-art', 'portfolio', 'patterns', 'checkin'] as const;
export type LLMTask = (typeof LLM_TASKS)[number];

export interface LLMRequest {
  /** What this call is for. Recorded with its token usage; never sent to the model. */
  task: LLMTask;
  /** Short role/instructions. */
  system: string;
  /** The digest or data to reason over. Must never contain secrets (see understand/redact.ts). */
  prompt: string;
  /** JSON Schema the answer must satisfy. */
  schema: Record<string, unknown>;
  /** Model for this call. Callers resolve it with `modelFor(config.llm, task)`. */
  model?: string;
}

/** What one call cost, as reported by the CLI. Numbers only; never the prompt or the answer. */
export interface LLMCallRecord {
  at: number;
  task: LLMTask;
  model: string; // as the API reports it, e.g. claude-sonnet-5-5
  ok: boolean; // false when the answer was unusable (the tokens were spent anyway)
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number; // list-price estimate; a subscription isn't billed per token
  durationMs: number;
}

export interface LLMProvider {
  readonly name: string;
  complete<T>(req: LLMRequest): Promise<T>;
}

export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMError';
  }
}

/** Minimal structural check: required keys exist. Enough to catch garbage; not a full validator. */
export function checkRequired(value: unknown, schema: Record<string, unknown>): void {
  const required = (schema.required as string[] | undefined) ?? [];
  if (typeof value !== 'object' || value === null) throw new LLMError('LLM answer was not a JSON object');
  const missing = required.filter((k) => !(k in value));
  if (missing.length) throw new LLMError(`LLM answer missing fields: ${missing.join(', ')}`);
}
