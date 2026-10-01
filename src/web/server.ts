// Local dashboard. Binds to 127.0.0.1 only. The one write it accepts is a journal
// entry (into data/journal.db). Host and Origin checks block DNS rebinding and
// cross-site form posts.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { openDb } from '../db.ts';
import { readTextSafe } from '../fs/read.ts';
import { correlate } from '../journal/correlate.ts';
import { addEntry, allEntries, openJournal, recentCheckins } from '../journal/journal.ts';
import { latestHypotheses } from '../patterns/hypotheses.ts';
import { computePatterns, loadHistories, snapshotDays } from '../patterns/metrics.ts';
import { ROOT } from '../paths.ts';
import { dailyActivity, lastScan, latestProjects, weeklyActivity } from '../store.ts';
import { latestPortfolio } from '../understand/portfolio.ts';
import { getProfile } from '../understand/profile.ts';
import { localDate } from '../util.ts';
import { journalPage, notFound, overview, patternsPage, projectPage } from './views.ts';

const CSS_PATH = join(ROOT, 'src', 'web', 'style.css');

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8'): void {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'self'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function readBody(req: IncomingMessage, limit = 16_384): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function startServer(port: number): Promise<{ url: string; close: () => void }> {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 403, 'forbidden host', 'text/plain');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      if (req.method === 'POST' && url.pathname === '/journal') {
        const origin = req.headers.origin;
        if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return send(res, 403, 'forbidden origin', 'text/plain');
        const form = new URLSearchParams(await readBody(req));
        const text = (form.get('text') ?? '').trim().slice(0, 4000);
        const scoreOf = (k: string) => {
          const n = Number(form.get(k));
          return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
        };
        if (text) addEntry(openJournal(), text, scoreOf('energy'), scoreOf('mood'));
        res.writeHead(303, { location: '/journal?saved=1' });
        return res.end();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');

      if (url.pathname === '/style.css') return send(res, 200, readTextSafe(CSS_PATH) ?? '', 'text/css; charset=utf-8');

      const db = openDb();
      try {
        if (url.pathname === '/') {
          const projects = latestProjects(db);
          const weekly = weeklyActivity(db, 26);
          const weekAgo = localDate(Date.now() - 7 * 86_400_000);
          const week = db.prepare(`
            SELECT count(DISTINCT project_id) AS touched, coalesce(sum(CASE WHEN source = 'git' THEN count END), 0) AS commits
            FROM activity_days WHERE date > ?`).get(weekAgo) as { touched: number; commits: number };
          const shipped = db.prepare('SELECT count(DISTINCT project_id) AS n FROM signals WHERE date > ?').get(weekAgo) as { n: number };
          return send(res, 200, overview({
            projects,
            profiles: new Map(projects.map((p) => [p.id, getProfile(db, p)])),
            weekly,
            report: latestPortfolio(db),
            week: { touched: week.touched, commits: week.commits, shipped: shipped.n },
            scannedAt: lastScan(db)?.finishedAt ?? null,
          }));
        }
        const m = /^\/p\/([a-z0-9-]+)$/.exec(url.pathname);
        if (m) {
          const p = latestProjects(db).find((x) => x.id === m[1]);
          if (!p) return send(res, 404, notFound());
          return send(res, 200, projectPage({
            p,
            profile: getProfile(db, p),
            weeks: weeklyActivity(db, 52).get(p.id) ?? new Array(52).fill(0),
            signals: db.prepare('SELECT date, kind, text FROM signals WHERE project_id = ? ORDER BY date DESC').all(p.id) as { date: string; kind: string; text: string }[],
            marks: db.prepare('SELECT date, type, note FROM events WHERE project_id = ? ORDER BY date DESC').all(p.id) as { date: string; type: string; note: string | null }[],
          }));
        }
        if (url.pathname === '/patterns') {
          const { histories, foreign, noHistory } = loadHistories(db, latestProjects(db));
          const patterns = computePatterns(histories, { foreign, noHistory, snapshotDays: snapshotDays(db) });
          const corr = correlate(allEntries(openJournal()), dailyActivity(db));
          return send(res, 200, patternsPage(patterns, latestHypotheses(db), corr));
        }
        if (url.pathname === '/journal') {
          const journal = openJournal();
          const entries = allEntries(journal);
          return send(res, 200, journalPage(entries, recentCheckins(journal, 6), correlate(entries, dailyActivity(db)), url.searchParams.has('saved')));
        }
        return send(res, 404, notFound());
      } finally {
        db.close();
      }
    } catch (err) {
      send(res, 500, `error: ${(err as Error).message}`, 'text/plain');
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() }));
  });
}
