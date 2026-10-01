import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fallbackQuestions, type CheckinContext } from '../src/journal/checkin.ts';
import { correlate, pearson } from '../src/journal/correlate.ts';
import { addEntry, allEntries, openJournal, recentCheckins, saveCheckin, type Entry } from '../src/journal/journal.ts';
import { DATA_DIR } from '../src/paths.ts';
import { cleanup, TMP } from './helpers.ts';

after(cleanup);

describe('journal storage', () => {
  it('lives in its own database file inside data/', () => {
    const db = openJournal(join(TMP, 'journal.db'));
    addEntry(db, 'feeling scattered', 2, null);
    addEntry(db, 'good day', 4, 5);
    assert.deepEqual(allEntries(db).map((e) => e.text).sort(), ['feeling scattered', 'good day']);
    assert.throws(() => addEntry(db, 'bad score', 9, null)); // CHECK constraint
    saveCheckin(db, 'fallback', [{ question: 'q?', basis: 'b' }], ['a']);
    assert.equal(recentCheckins(db)[0].answers[0], 'a');
    db.close();
  });

  it('defaults to data/journal.db, separate from manager.db', () => {
    assert.equal(join(DATA_DIR, 'journal.db').endsWith('data/journal.db'), true);
  });
});

describe('correlations', () => {
  it('pearson basics', () => {
    assert.equal(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
    assert.equal(pearson([1, 2, 3, 4], [8, 6, 4, 2]), -1);
    assert.equal(pearson([1, 1, 1], [1, 2, 3]), 0);
  });

  const day = (i: number) => new Date(2026, 8, 1 + i, 12).getTime();
  const entries = (n: number): Entry[] =>
    Array.from({ length: n }, (_, i) => ({ id: i, at: day(i), text: '', energy: (i % 5) + 1, mood: null }));
  const activity = (n: number) => new Map(Array.from({ length: n }, (_, i) => {
    const d = new Date(day(i));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return [key, { projects: (i % 5) + 1, commits: 3 }];
  }));

  it('stays silent below the minimum number of scored days', () => {
    const r = correlate(entries(5), activity(5));
    assert.equal(r.findings.length, 0);
    assert.equal(r.checked, 0);
    assert.equal(r.scoredDays.energy, 5);
  });

  it('reports a same-day relationship once there is enough data', () => {
    const r = correlate(entries(15), activity(15));
    const same = r.findings.find((f) => f.score === 'energy' && f.measure === 'projects touched' && f.lag === 'same day');
    assert.ok(same);
    assert.equal(same.r, 1);
    assert.equal(same.n, 15);
  });
});

describe('fallback check-in questions', () => {
  const base: CheckinContext = {
    today: '2026-10-01',
    week: { touched: [], commits: 0, shipped: [] },
    month: { touched: 0, started: [] },
    focus: null,
    stalledClose: [],
    journal: { entries: 3, avgEnergy: 3, avgMood: null },
    previousQuestions: [],
    headline: null,
  };

  it('asks about scatter when many projects moved and none shipped', () => {
    const q = fallbackQuestions({ ...base, week: { touched: ['a', 'b', 'c', 'd', 'e', 'f'], commits: 20, shipped: [] } });
    assert.match(q[0].question, /You touched 6 projects this week and shipped none/);
  });

  it('grounds every question in the data and returns at most 4', () => {
    const q = fallbackQuestions({
      ...base,
      week: { touched: ['a', 'b', 'c'], commits: 5, shipped: [] },
      focus: { name: 'colorwizard', activeDays30: 16 },
      stalledClose: ['VCR'],
      month: { touched: 6, started: ['x', 'y'] },
      journal: { entries: 0, avgEnergy: null, avgMood: null },
    });
    assert.ok(q.length >= 2 && q.length <= 4);
    for (const x of q) assert.ok(x.basis.length > 0);
    assert.ok(q.some((x) => x.question.includes('colorwizard')));
    assert.ok(q.some((x) => x.question.includes('VCR')));
  });

  it('avoids repeating recent questions when it can', () => {
    const ctx = { ...base, week: { touched: ['a', 'b', 'c'], commits: 1, shipped: [] }, journal: { entries: 0, avgEnergy: null, avgMood: null } };
    const first = fallbackQuestions(ctx);
    const second = fallbackQuestions({ ...ctx, previousQuestions: [first[0].question], focus: { name: 'p', activeDays30: 9 } });
    assert.ok(!second.some((q) => q.question === first[0].question));
  });
});
