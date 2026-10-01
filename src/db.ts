// Project data lives in data/manager.db. (The journal gets its own file in slice 4.)

import { join } from 'node:path';
import { openDatabase, type DatabaseSync } from './fs/guard.ts';
import { DATA_DIR } from './paths.ts';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id          TEXT PRIMARY KEY,           -- stable slug
    path        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    root        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    first_seen  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    missing     INTEGER NOT NULL DEFAULT 0
  );
  -- One snapshot per project per day (the latest scan that day wins).
  CREATE TABLE snapshots (
    project_id       TEXT NOT NULL REFERENCES projects(id),
    date             TEXT NOT NULL,          -- YYYY-MM-DD, local time
    taken_at         INTEGER NOT NULL,
    fingerprint      TEXT NOT NULL,
    last_activity_at INTEGER,
    commits_30d      INTEGER,
    dirty_count      INTEGER,
    file_count       INTEGER NOT NULL,
    size_bytes       INTEGER NOT NULL,
    todo_count       INTEGER NOT NULL,
    facts_json       TEXT NOT NULL,
    PRIMARY KEY (project_id, date)
  );
  CREATE TABLE scans (
    id            INTEGER PRIMARY KEY,
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER,
    project_count INTEGER
  );
  `,
  `
  -- One profile per project per fingerprint; the newest is current.
  CREATE TABLE profiles (
    project_id   TEXT NOT NULL REFERENCES projects(id),
    fingerprint  TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    model        TEXT NOT NULL,
    json         TEXT NOT NULL,
    PRIMARY KEY (project_id, fingerprint)
  );
  CREATE TABLE reports (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL,            -- 'portfolio' (later: 'patterns')
    input_hash   TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    model        TEXT NOT NULL,
    json         TEXT NOT NULL
  );
  `,
  `
  -- Dated activity, backfilled from full git history (source 'git') or file mtimes (source 'files').
  CREATE TABLE activity_days (
    project_id TEXT NOT NULL REFERENCES projects(id),
    date       TEXT NOT NULL,
    source     TEXT NOT NULL,
    count      INTEGER NOT NULL,
    PRIMARY KEY (project_id, date, source)
  );
  -- Evidence that something shipped: release tags and launch-like commit subjects.
  CREATE TABLE signals (
    project_id TEXT NOT NULL REFERENCES projects(id),
    date       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    text       TEXT NOT NULL
  );
  CREATE INDEX signals_project ON signals(project_id);
  -- Lifecycle marks made by hand: manager mark <project> shipped|paused|abandoned|active
  CREATE TABLE events (
    id         INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    date       TEXT NOT NULL,
    type       TEXT NOT NULL,
    note       TEXT,
    created_at INTEGER NOT NULL
  );
  `,
];

export function openDb(file = join(DATA_DIR, 'manager.db')): DatabaseSync {
  const db = openDatabase(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec('COMMIT');
  }
  return db;
}

export { localDate } from './util.ts';
