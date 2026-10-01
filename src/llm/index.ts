import type { LLMConfig } from '../config.ts';
import { ClaudeCliProvider } from './claude-cli.ts';
import type { LLMProvider } from './provider.ts';

export function createProvider(cfg: LLMConfig): LLMProvider {
  return new ClaudeCliProvider({ command: cfg.command, model: cfg.model, timeoutSeconds: cfg.timeoutSeconds });
}
