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
}

interface RawConfig {
  roots?: { path: string; exclude?: string[] }[];
  include?: string[];
  exclude?: string[];
  discoveryDepth?: number;
  skipDirs?: string[];
  maxFilesPerProject?: number;
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
  };
}
