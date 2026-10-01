// The journal lives in its own database file (data/journal.db), separate from project data.

import { join } from 'node:path';
import { openDatabase, type DatabaseSync } from '../fs/guard.ts';
import { DATA_DIR } from '../paths.ts';

const MIGRATIONS = [
  `
  CREATE TABLE entries (
    id     INTEGER PRIMARY KEY,
    at     INTEGER NOT NULL,
    text   TEXT NOT NULL,
    energy INTEGER CHECK (energy BETWEEN 1 AND 5),
    mood   INTEGER CHECK (mood BETWEEN 1 AND 5)
  );
  CREATE TABLE checkins (
    id             INTEGER PRIMARY KEY,
    at             INTEGER NOT NULL,
    source         TEXT NOT NULL,          -- 'llm' or 'fallback'
    questions_json TEXT NOT NULL,          -- [{question, basis}]
    answers_json   TEXT NOT NULL           -- [string|null], aligned with questions
  );
  `,
];

export function openJournal(file = join(DATA_DIR, 'journal.db')): DatabaseSync {
  const db = openDatabase(file);
  db.exec('PRAGMA journal_mode = WAL;');
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec('COMMIT');
  }
  return db;
}

export interface Entry {
  id: number;
  at: number;
  text: string;
  energy: number | null;
  mood: number | null;
}

export function addEntry(db: DatabaseSync, text: string, energy: number | null, mood: number | null, at = Date.now()): Entry {
  const id = Number(db.prepare('INSERT INTO entries (at, text, energy, mood) VALUES (?, ?, ?, ?)').run(at, text, energy, mood).lastInsertRowid);
  return { id, at, text, energy, mood };
}

export function entriesSince(db: DatabaseSync, since: number): Entry[] {
  return db.prepare('SELECT id, at, text, energy, mood FROM entries WHERE at >= ? ORDER BY at DESC').all(since) as unknown as Entry[];
}

export function allEntries(db: DatabaseSync): Entry[] {
  return entriesSince(db, 0);
}

export interface Question {
  question: string;
  basis: string; // the data point that prompted it
}

export interface Checkin {
  id: number;
  at: number;
  source: string;
  questions: Question[];
  answers: (string | null)[];
}

export function saveCheckin(db: DatabaseSync, source: string, questions: Question[], answers: (string | null)[], at = Date.now()): number {
  return Number(db.prepare('INSERT INTO checkins (at, source, questions_json, answers_json) VALUES (?, ?, ?, ?)')
    .run(at, source, JSON.stringify(questions), JSON.stringify(answers)).lastInsertRowid);
}

export function recentCheckins(db: DatabaseSync, limit = 3): Checkin[] {
  const rows = db.prepare('SELECT id, at, source, questions_json, answers_json FROM checkins ORDER BY at DESC LIMIT ?').all(limit) as
    { id: number; at: number; source: string; questions_json: string; answers_json: string }[];
  return rows.map((r) => ({ id: r.id, at: r.at, source: r.source, questions: JSON.parse(r.questions_json), answers: JSON.parse(r.answers_json) }));
}
