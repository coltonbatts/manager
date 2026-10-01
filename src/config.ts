import { join, resolve } from 'node:path';
import { readTextSafe } from './fs/read.ts';
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
}

export interface LLMConfig {
  provider: 'claude-cli';
  command: string;
  model: string; // per-project profiles
  reportModel: string; // portfolio synthesis, patterns, check-ins
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
      command: raw.llm?.command ?? 'claude',
      model: raw.llm?.model ?? 'sonnet',
      reportModel: raw.llm?.reportModel ?? 'opus',
      timeoutSeconds: raw.llm?.timeoutSeconds ?? 180,
      concurrency: raw.llm?.concurrency ?? 3,
    },
    // Journal text stays on this machine unless you opt in; check-ins otherwise only see scores.
    journal: { shareTextWithLLM: raw.journal?.shareTextWithLLM ?? false },
  };
}
