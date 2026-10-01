// Turns configured roots into a list of candidate projects.
//
// Rules:
//  - A folder with .git or a code manifest is a project (we don't descend into it).
//  - A folder with projects somewhere below it (within discoveryDepth) is a container:
//    we expand it, and its non-code children with content become projects too.
//  - Any other non-empty folder is a project (creative work, notes, …).
//  - Excluded, junk, hidden and media-cache folders are skipped. Manager never sees itself.

import { readdirSync, existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { Config } from '../config.ts';
import { hasEntries, isInside, isSkippedDir, isVenv, listSubdirs, realpath } from '../fs/read.ts';
import { ROOT } from '../paths.ts';

export interface Candidate {
  path: string;
  name: string;
  root: string;
  isGit: boolean;
}

const MANIFESTS = [
  'package.json', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod',
  'Package.swift', 'Gemfile', 'composer.json', 'deno.json', 'pubspec.yaml', 'CMakeLists.txt', 'build.gradle',
];

export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

export function isCodeProject(dir: string): boolean {
  if (isGitRepo(dir) || MANIFESTS.some((m) => existsSync(join(dir, m)))) return true;
  try {
    return readdirSync(dir).some((n) => n.endsWith('.xcodeproj'));
  } catch {
    return false;
  }
}

function hasProjectBelow(dir: string, depth: number, skip: Set<string>): boolean {
  if (depth <= 0) return false;
  for (const sub of listSubdirs(dir)) {
    if (isSkippedDir(basename(sub), skip) || isVenv(sub)) continue;
    if (isCodeProject(sub) || hasProjectBelow(sub, depth - 1, skip)) return true;
  }
  return false;
}

/** `self` is Manager's own directory, which is never a project (overridable for tests, whose fixtures live inside it). */
export function discover(config: Config, { self = ROOT } = {}): Candidate[] {
  let manager = self;
  try { manager = realpath(self); } catch { /* keep as given */ }
  const found = new Map<string, Candidate>();

  const add = (path: string, root: string) => {
    let real: string;
    try { real = realpath(path); } catch { return; }
    if (isInside(real, manager) || isInside(manager, real)) return;
    if (config.exclude.some((e) => isInside(real, e))) return;
    if (!found.has(real)) found.set(real, { path: real, name: basename(real), root, isGit: isGitRepo(real) });
  };

  const visit = (dir: string, root: RootRef, depth: number) => {
    for (const child of listSubdirs(dir)) {
      const name = basename(child);
      if (isSkippedDir(name, config.skipDirs) || isVenv(child)) continue;
      if (root.exclude.has(relative(root.path, child)) || root.exclude.has(name)) continue;
      if (isCodeProject(child)) add(child, root.path);
      else if (hasProjectBelow(child, depth - 1, config.skipDirs)) visit(child, root, depth - 1);
      else if (hasEntries(child)) add(child, root.path);
    }
  };

  for (const r of config.roots) {
    if (!existsSync(r.path)) continue;
    visit(r.path, { path: r.path, exclude: new Set(r.exclude) }, config.discoveryDepth);
  }
  for (const p of config.include) if (existsSync(p)) add(p, p);

  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

interface RootRef {
  path: string;
  exclude: Set<string>;
}
