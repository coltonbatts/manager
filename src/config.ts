import { join, resolve } from 'node:path';
import { readTextSafe } from './fs/read.ts';
import { LLM_TASKS, type LLMTask } from './llm/provider.ts';
import { expandHome, ROOT } from './paths.ts';

export interface RootConfig {
  path: string; // absolute
  exclude: string[]; // child folder names (or relative paths) to skip
}

export interface Config {
  roots: RootConfig[];
  include: string[]; // extra project paths, always treated as projects
  exclude: string[]; // absolute paths never treated as projects
  discoveryDepth: number;
  skipDirs: Set<string>;
  maxFilesPerProject: number;
  identities: string[]; // your git author names/emails/GitHub logins
  llm: LLMConfig;
  journal: { shareTextWithLLM: boolean };
  usage: { refreshMinutes: number; transcriptsDir: string };
}

export interface LLMConfig {
  provider: 'claude-cli';
  command: string;
  model: string; // default for per-project work: profiles, re-entry notes, prior art
  reportModel: string; // default for portfolio synthesis, patterns, check-ins
  models: Partial<Record<LLMTask, string>>; // per-task override of the two defaults
  timeoutSeconds: number;
  concurrency: number;
}

interface RawConfig {
  roots?: { path: string; exclude?: string[] }[];
  include?: string[];
  exclude?: string[];
  discoveryDepth?: number;
  skipDirs?: string[];
  maxFilesPerProject?: number;
  identities?: string[];
  llm?: Partial<LLMConfig>;
  journal?: { shareTextWithLLM?: boolean };
  usage?: { refreshMinutes?: number; transcriptsDir?: string };
}

const REPORT_TASKS: readonly LLMTask[] = ['portfolio', 'patterns', 'checkin'];

/** The model for one kind of call: its own override, else the per-project or report default. */
export function modelFor(cfg: Pick<LLMConfig, 'model' | 'reportModel' | 'models'>, task: LLMTask): string {
  return cfg.models[task] ?? (REPORT_TASKS.includes(task) ? cfg.reportModel : cfg.model);
}

export const CONFIG_PATH = join(ROOT, 'manager.config.json');

export function loadConfig(path = CONFIG_PATH): Config {
  const text = readTextSafe(path);
  if (!text) throw new Error(`missing or unreadable config: ${path}`);
  return normalizeConfig(JSON.parse(text) as RawConfig);
}

export function normalizeConfig(raw: RawConfig): Config {
  const abs = (p: string) => resolve(expandHome(p));
  return {
    roots: (raw.roots ?? []).map((r) => ({ path: abs(r.path), exclude: r.exclude ?? [] })),
    include: (raw.include ?? []).map(abs),
    exclude: (raw.exclude ?? []).map(abs),
    discoveryDepth: raw.discoveryDepth ?? 3,
    skipDirs: new Set(raw.skipDirs ?? []),
    maxFilesPerProject: raw.maxFilesPerProject ?? 20_000,
    identities: raw.identities ?? [],
    llm: {
      provider: 'claude-cli',
      command: expandHome(raw.llm?.command ?? 'claude'),
      model: raw.llm?.model ?? 'sonnet',
      reportModel: raw.llm?.reportModel ?? 'opus',
      models: validModels(raw.llm?.models),
      timeoutSeconds: raw.llm?.timeoutSeconds ?? 180,
      concurrency: raw.llm?.concurrency ?? 3,
    },
    // Journal text stays on this machine unless you opt in; check-ins otherwise only see scores.
    journal: { shareTextWithLLM: raw.journal?.shareTextWithLLM ?? false },
    usage: {
      refreshMinutes: raw.usage?.refreshMinutes ?? 5,
      transcriptsDir: abs(raw.usage?.transcriptsDir ?? '~/.claude/projects'),
    },
  };
}

function validModels(raw: unknown): Partial<Record<LLMTask, string>> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null) throw new Error('config llm.models must be an object of task → model');
  const out: Partial<Record<LLMTask, string>> = {};
  for (const [task, model] of Object.entries(raw)) {
    if (!(LLM_TASKS as readonly string[]).includes(task)) throw new Error(`config llm.models: unknown task "${task}" (expected one of ${LLM_TASKS.join(', ')})`);
    if (typeof model !== 'string' || !model) throw new Error(`config llm.models.${task} must be a model name`);
    out[task as LLMTask] = model;
  }
  return out;
}
