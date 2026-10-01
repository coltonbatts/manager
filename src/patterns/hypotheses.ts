// The scientist: turns metrics into a few honest, falsifiable hypotheses.

import { createHash } from 'node:crypto';
import type { DatabaseSync } from '../fs/guard.ts';
import type { LLMProvider } from '../llm/provider.ts';
import type { Patterns } from './metrics.ts';

export interface Hypothesis {
  claim: string;
  evidence: string[];
  n: number;
  confidence: 'low' | 'medium' | 'high';
  alternative: string;
  wouldChangeMyMind: string;
}

export const HYPOTHESES_SCHEMA = {
  type: 'object',
  required: ['hypotheses', 'dataCaveat'],
  properties: {
    hypotheses: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        required: ['claim', 'evidence', 'n', 'confidence', 'alternative', 'wouldChangeMyMind'],
        properties: {
          claim: { type: 'string', description: 'A specific, testable statement about Colton\'s working pattern.' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Exact numbers from the metrics that support it.' },
          n: { type: 'integer', description: 'Sample size the claim rests on.' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          alternative: { type: 'string', description: 'The most plausible boring explanation for the same numbers.' },
          wouldChangeMyMind: { type: 'string', description: 'What future data would weaken this.' },
        },
      },
    },
    dataCaveat: { type: 'string', description: 'One sentence on the biggest limitation of this data.' },
  },
} as const;

const SYSTEM = `You are a careful behavioral scientist helping Colton, a one-person creative-tech studio owner, understand his own working patterns.
You get computed metrics from his git history and folder activity. Form 3–5 hypotheses.
Rules:
- Every claim must cite specific numbers from the metrics. Never invent data.
- State n honestly. With n < 10, confidence is low. High confidence needs a large, consistent effect.
- Always give the boring alternative explanation (e.g. git only captures code; AI agents commit too; old repos were imported in bulk; creative work leaves few traces).
- Prefer patterns that are useful to know, e.g. where projects stall, how attention spreads, starts vs finishes.
- Plain, warm, direct. No diagnosis, no moralizing.`;

export interface PatternsReport {
  hypotheses: Hypothesis[];
  dataCaveat: string;
}

export function patternsHash(p: Patterns): string {
  const { generatedFor: _date, ...rest } = p;
  return createHash('sha1').update(JSON.stringify(rest)).digest('hex');
}

export async function formHypotheses(
  db: DatabaseSync, llm: LLMProvider, model: string, p: Patterns, force = false,
): Promise<{ report: PatternsReport; generatedAt: number; cached: boolean }> {
  const hash = patternsHash(p);
  const last = db.prepare("SELECT json, generated_at, input_hash FROM reports WHERE kind = 'patterns' ORDER BY id DESC LIMIT 1").get() as
    { json: string; generated_at: number; input_hash: string } | undefined;
  if (!force && last && last.input_hash === hash) {
    return { report: JSON.parse(last.json) as PatternsReport, generatedAt: last.generated_at, cached: true };
  }
  const report = await llm.complete<PatternsReport>({
    system: SYSTEM,
    prompt: `Metrics (JSON):\n${JSON.stringify(p, null, 1)}`,
    schema: HYPOTHESES_SCHEMA,
    model,
  });
  const generatedAt = Date.now();
  db.prepare("INSERT INTO reports (kind, input_hash, generated_at, model, json) VALUES ('patterns', ?, ?, ?, ?)")
    .run(hash, generatedAt, model, JSON.stringify(report));
  return { report, generatedAt, cached: false };
}
