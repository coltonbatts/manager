import type { LLMConfig } from '../config.ts';
import type { DatabaseSync } from '../fs/guard.ts';
import { recordCall } from '../usage/calls.ts';
import { ClaudeCliProvider } from './claude-cli.ts';
import type { LLMProvider } from './provider.ts';

/** Pass `db` to log every call's token usage to llm_calls. */
export function createProvider(cfg: LLMConfig, db?: DatabaseSync): LLMProvider {
  return new ClaudeCliProvider({
    command: cfg.command,
    model: cfg.model,
    timeoutSeconds: cfg.timeoutSeconds,
    onCall: db ? (call) => recordCall(db, call) : undefined,
  });
}
