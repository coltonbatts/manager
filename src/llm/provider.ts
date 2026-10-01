// The intelligence boundary. Everything that wants an LLM goes through this
// interface, so the `claude -p` implementation can be swapped later.

export interface LLMRequest {
  /** Short role/instructions. */
  system: string;
  /** The digest or data to reason over. Must never contain secrets (see understand/redact.ts). */
  prompt: string;
  /** JSON Schema the answer must satisfy. */
  schema: Record<string, unknown>;
  /** Optional model override (e.g. a stronger model for portfolio synthesis). */
  model?: string;
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
