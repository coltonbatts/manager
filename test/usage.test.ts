import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { openDb } from '../src/db.ts';
import { writeText } from '../src/fs/guard.ts';
import { parseCallUsage } from '../src/llm/claude-cli.ts';
import { callsByTask, recordCall } from '../src/usage/calls.ts';
import { elapsedFraction, parseLimits, parseReset } from '../src/usage/limits.ts';
import { parseTranscript, syncTranscripts, usageByDay } from '../src/usage/transcripts.ts';
import { cleanup, fixture, TMP } from './helpers.ts';

after(cleanup);

const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 45% used · resets Oct 1 at 5:39pm (America/Chicago)
Current week (all models): 29% used · resets Oct 4 at 11:59am (America/Chicago)
Current week (Sonnet only): 3% used

Last 24h · 132 requests · 1 session`;

describe('plan limits parsing', () => {
  const now = new Date(2026, 9, 1, 14, 0).getTime(); // Oct 1, 2:00pm local

  it('reads each "Current …: N% used" line', () => {
    const limits = parseLimits(SAMPLE, now);
    assert.deepEqual(limits.map((l) => [l.label, l.percent]), [['session', 45], ['week (all models)', 29], ['week (sonnet only)', 3]]);
    assert.equal(limits[0].resetsText, 'Oct 1 at 5:39pm');
    assert.equal(limits[2].resetsAt, null);
  });

  it('parses reset times in local time', () => {
    assert.equal(parseReset('Oct 1 at 5:39pm', now), new Date(2026, 9, 1, 17, 39).getTime());
    assert.equal(parseReset('Oct 4 at 11:59am', now), new Date(2026, 9, 4, 11, 59).getTime());
    assert.equal(parseReset('Oct 4 at 12pm', now), new Date(2026, 9, 4, 12, 0).getTime());
    assert.equal(parseReset('Oct 4 at 12am', now), new Date(2026, 9, 4, 0, 0).getTime());
    assert.equal(parseReset('5:39pm', now), new Date(2026, 9, 1, 17, 39).getTime());
    assert.equal(parseReset('Jan 2 at 9am', new Date(2026, 11, 30).getTime()), new Date(2027, 0, 2, 9, 0).getTime());
    assert.equal(parseReset('whenever', now), null);
  });

  it('computes how far into the window we are', () => {
    const [session, week] = parseLimits(SAMPLE, now);
    // session resets 5:39pm, window 5h → started 12:39pm; at 2:00pm that's 81 of 300 minutes.
    assert.ok(Math.abs(elapsedFraction(session, now)! - 81 / 300) < 0.001);
    assert.ok(elapsedFraction(week, now)! > 0.5 && elapsedFraction(week, now)! < 0.6);
  });

  it('ignores output without limit lines', () => {
    assert.deepEqual(parseLimits('Not logged in · Please run /login'), []);
  });
});

const line = (o: object) => JSON.stringify(o);

describe('transcript usage', () => {
  const ts = '2026-09-30T15:00:00.000Z';
  const u = (output: number) => ({ input_tokens: 10, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 });
  const transcript = [
    line({ type: 'user', timestamp: ts, cwd: '/x/colorwizard', message: { role: 'user', content: 'SECRET PROMPT TEXT' } }),
    // the same message streamed twice: counted once, last line wins
    line({ type: 'assistant', timestamp: ts, cwd: '/x/colorwizard', requestId: 'r1', message: { id: 'm1', model: 'claude-opus-5-5', usage: u(5), content: 'hi' } }),
    line({ type: 'assistant', timestamp: ts, cwd: '/x/colorwizard', requestId: 'r1', message: { id: 'm1', model: 'claude-opus-5-5', usage: u(50), content: 'hi there' } }),
    line({ type: 'assistant', timestamp: ts, cwd: '/x/colorwizard', requestId: 'r2', message: { id: 'm2', model: 'claude-opus-5-5', usage: u(7) } }),
    line({ type: 'assistant', timestamp: ts, cwd: '/x/colorwizard', message: { id: 'm3', model: '<synthetic>', usage: u(1) } }),
    'not json',
  ].join('\n');

  it('counts each response once and keeps only numbers', async () => {
    const dir = fixture('transcripts', { 'proj/a.jsonl': transcript });
    const rows = await parseTranscript(join(dir, 'proj', 'a.jsonl'));
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0], date: '' }, {
      date: '', project: 'colorwizard', model: 'claude-opus-5-5', requests: 2, input: 20, output: 57, cacheRead: 200, cacheWrite: 10,
    });
    assert.ok(!JSON.stringify(rows).includes('SECRET'));
  });

  it('syncs incrementally and re-reads only changed files', async () => {
    const dir = fixture('transcripts2', { 'p/a.jsonl': transcript, 'p/b.jsonl': transcript.replaceAll('m1', 'n1').replaceAll('m2', 'n2') });
    const db = openDb(join(TMP, 'usage.db'));
    assert.deepEqual(await syncTranscripts(db, dir), { files: 2, parsed: 2 });
    assert.deepEqual(await syncTranscripts(db, dir), { files: 2, parsed: 0 });
    writeText(join(dir, 'p', 'b.jsonl'), transcript + '\n' + line({ type: 'assistant', timestamp: ts, cwd: '/x/y', message: { id: 'z', model: 'm', usage: u(1) } }));
    assert.deepEqual(await syncTranscripts(db, dir), { files: 2, parsed: 1 });
    const total = usageByDay(db, 3650, Date.parse('2026-10-01T12:00:00Z')).reduce((a, d) => a + d.requests, 0);
    assert.equal(total, 5); // a: 2, b (rewritten as a copy of a's ids + one more): 3
    db.close();
  });
});

describe("Manager's own calls", () => {
  const envelope = JSON.stringify({
    type: 'result', result: '{}', total_cost_usd: 0.0123, duration_ms: 2400,
    modelUsage: {
      'claude-haiku-4-5-20251001': { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0002 },
      'claude-sonnet-5-5': { inputTokens: 2, outputTokens: 400, cacheReadInputTokens: 50, cacheCreationInputTokens: 900, costUSD: 0.0121 },
    },
  });

  it('reads tokens, cost and the dominant model from the CLI envelope', () => {
    assert.deepEqual(parseCallUsage(envelope), {
      model: 'claude-sonnet-5-5', input: 102, output: 410, cacheRead: 50, cacheWrite: 900, costUsd: 0.0123, durationMs: 2400,
    });
  });

  it('returns null when there is no usage to read', () => {
    assert.equal(parseCallUsage('not json'), null);
    assert.equal(parseCallUsage(JSON.stringify({ result: 'x' })), null);
  });

  it('records calls and totals them per task and model', () => {
    const db = openDb(join(TMP, 'calls.db'));
    const base = { at: 1_000, model: 'claude-sonnet-5-5', ok: true, input: 10, output: 20, cacheRead: 30, cacheWrite: 40, costUsd: 0.5, durationMs: 1000 };
    recordCall(db, { ...base, task: 'profile' });
    recordCall(db, { ...base, task: 'profile', ok: false, costUsd: 0.25, durationMs: 3000 });
    recordCall(db, { ...base, task: 'portfolio', model: 'claude-opus-5-5', costUsd: 2 });
    recordCall(db, { ...base, task: 'profile', at: 5 }); // before the window
    const rows = callsByTask(db, 1_000);
    assert.deepEqual(rows.map((r) => [r.task, r.model, r.calls, r.failed, r.costUsd]), [
      ['portfolio', 'claude-opus-5-5', 1, 0, 2],
      ['profile', 'claude-sonnet-5-5', 2, 1, 0.75],
    ]);
    assert.equal(rows[1].avgMs, 2000);
    db.close();
  });
});
