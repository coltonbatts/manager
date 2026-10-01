import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computePatterns, type ProjectHistory } from '../src/patterns/metrics.ts';
import { makeIsMine } from '../src/scan/facts.ts';

describe('identity matching', () => {
  const isMine = makeIsMine(['Colton Batts', 'coltonbatts', 'colton.batts@gmail.com']);
  it('matches by name, email (any case) and GitHub noreply login', () => {
    assert.equal(isMine('Colton Batts', 'x@y.z'), true);
    assert.equal(isMine('someone', 'ColtonBatts@Gmail.com'.replace('ColtonBatts', 'colton.batts')), true);
    assert.equal(isMine('cb', '129699175+coltonbatts@users.noreply.github.com'), true);
    assert.equal(isMine('cb', 'coltonbatts@users.noreply.github.com'), true);
  });
  it('rejects other people', () => {
    assert.equal(isMine('Daniel Han', 'danielhanchen@gmail.com'), false);
    assert.equal(isMine('pre-commit-ci[bot]', '66853113+pre-commit-ci[bot]@users.noreply.github.com'), false);
  });
  it('counts everything when no identities are configured', () => {
    assert.equal(makeIsMine([])('anyone', 'a@b.c'), true);
  });
});

function h(name: string, days: string[], extra: Partial<ProjectHistory> = {}): ProjectHistory {
  return { id: name, name, days, commitDays: days, commits: days.length, source: 'git', shipDates: [], ...extra };
}

describe('pattern metrics', () => {
  const today = '2026-10-01'; // a Thursday
  const histories = [
    h('busy', ['2026-09-28', '2026-09-29', '2026-09-30']),
    h('also-this-week', ['2026-09-29']),
    h('old-burst', ['2025-01-01', '2025-01-02'], { stage: 'building', closeness: 'close' }),
    h('shipped-thing', ['2026-03-01', '2026-03-20', '2026-06-01'], { shipDates: ['2026-03-20'], stage: 'shipped', closeness: 'shipped' }),
  ];
  const p = computePatterns(histories, { foreign: 1, noHistory: 2, snapshotDays: 3 }, today);

  it('counts breadth per Monday-start week', () => {
    assert.equal(p.breadth.weeks.length, 26);
    assert.equal(p.breadth.weeks.at(-1)!.week, '2026-09-28');
    assert.equal(p.breadth.weeks.at(-1)!.projects, 2);
  });

  it('counts starts and ship evidence by month', () => {
    const march = p.startsVsFinishes.months.find((m) => m.month === '2026-03')!;
    assert.deepEqual([march.started, march.shipped], [1, 1]);
    assert.equal(p.startsVsFinishes.started, 3); // old-burst started outside the 12-month window
  });

  it('measures lifespan only for quiet projects', () => {
    assert.equal(p.lifespan.n, 2);
    assert.deepEqual(p.lifespan.buckets['2–7 days'], 1); // old-burst: 2-day span
    assert.deepEqual(p.lifespan.buckets['90+ days'], 1); // shipped-thing: Mar 1 → Jun 1
  });

  it('tallies where quiet projects stopped, from profiles', () => {
    assert.deepEqual(p.stallPoint.byCloseness, { close: 1, shipped: 1 });
    assert.equal(p.stallPoint.quietWithShipEvidence, 1);
  });

  it('counts revivals after 30+ day gaps', () => {
    // shipped-thing: Mar 20 → Jun 1 is a revived gap; old-burst and shipped-thing are currently quiet.
    assert.deepEqual(p.revivals, { gaps: 3, revived: 1 });
  });

  it('reports attention shares over 90 days', () => {
    assert.equal(p.attention.projects[0].name, 'busy');
    assert.equal(p.attention.top1Share, 0.75);
  });

  it('carries coverage metadata through', () => {
    assert.equal(p.coverage.foreignExcluded, 1);
    assert.equal(p.coverage.snapshotDays, 3);
    assert.equal(p.coverage.firstDate, '2025-01-01');
  });
});
