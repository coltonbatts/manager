import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { openDb } from '../src/db.ts';
import { git } from '../src/git.ts';
import type { LLMProvider, LLMRequest } from '../src/llm/provider.ts';
import { latestProjects } from '../src/store.ts';
import { checkPriorArt, getPriorArt, type PriorArt } from '../src/understand/prior-art.ts';
import { buildReentryEvidence, filterDiff, isEligible, lastSession } from '../src/understand/reentry.ts';
import { cleanup, fixture, scanFixture, TMP } from './helpers.ts';

after(cleanup);

describe('last session detection', () => {
  it('takes the final run of days, allowing one-day gaps', () => {
    assert.deepEqual(lastSession(['2026-08-01', '2026-09-20', '2026-09-22', '2026-09-23']), { start: '2026-09-20', end: '2026-09-23' });
    assert.deepEqual(lastSession(['2026-09-01', '2026-09-10']), { start: '2026-09-10', end: '2026-09-10' });
    assert.equal(lastSession([]), null);
  });
  it('caps a session at a week', () => {
    const days = Array.from({ length: 20 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
    assert.deepEqual(lastSession(days), { start: '2026-09-14', end: '2026-09-20' });
  });
});

describe('diff filtering', () => {
  const diff = [
    'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n',
    'diff --git a/.env.local b/.env.local\n@@ -1 +1 @@\n-KEY=old\n+KEY=supersecret\n',
    'diff --git a/certs/server.pem b/certs/server.pem\n+-----BEGIN\n',
    `diff --git a/big.ts b/big.ts\n${'+x\n'.repeat(2000)}`,
  ].join('');
  const out = filterDiff(diff);
  it('drops secret files entirely', () => {
    assert.match(out, /src\/app\.ts/);
    assert.doesNotMatch(out, /supersecret|\.env\.local|server\.pem/);
  });
  it('caps large hunks', () => {
    assert.match(out, /hunk truncated/);
    assert.ok(out.length < 4000);
  });
});

describe('git diff safety', () => {
  it('refuses diff without --no-ext-diff and --no-textconv', () => {
    assert.throws(() => git('.', ['diff', 'HEAD']), /no-ext-diff/);
    assert.throws(() => git('.', ['diff', '--no-ext-diff']), /no-textconv/);
  });
});

describe('re-entry evidence', () => {
  it('includes uncommitted work and TODOs but never secret files', async () => {
    const root = fixture('reentry', {
      'proj/src/app.ts': 'export const a = 1;\n',
      'proj/README.md': '# proj',
    });
    const dir = join(root, 'proj');
    const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
    g('init', '-q');
    g('add', '.');
    g('commit', '-qm', 'feat: first');
    const { writeText } = await import('../src/fs/guard.ts');
    writeText(join(dir, 'src', 'app.ts'), 'export const a = 2; // TODO: finish the export\n');
    writeText(join(dir, '.env'), 'API_KEY=supersecretvalue\n');
    writeText(join(dir, 'src', 'new.ts'), 'x');

    const db = openDb(join(TMP, 'reentry.db'));
    await scanFixture(db, root);
    const [p] = latestProjects(db);
    const ev = await buildReentryEvidence(db, p);
    assert.match(ev, /feat: first/);
    assert.match(ev, /\+export const a = 2/);
    assert.match(ev, /src\/new\.ts/);
    assert.match(ev, /src\/app\.ts:1 .*TODO: finish the export/);
    assert.doesNotMatch(ev, /supersecretvalue|\.env/);
    db.close();
  });

  it('only notes projects quiet for 2–60 days', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    const p = (daysAgo: number, extra = {}) => ({
      facts: { lastActivityAt: now - daysAgo * 86_400_000, fileCount: 3, git: { foreign: false }, ...extra },
    }) as unknown as Parameters<typeof isEligible>[0];
    assert.equal(isEligible(p(1), now), false);
    assert.equal(isEligible(p(8), now), true);
    assert.equal(isEligible(p(90), now), false);
    assert.equal(isEligible(p(8, { git: { foreign: true } }), now), false);
  });
});

class Scripted implements LLMProvider {
  readonly name = 'scripted';
  calls: LLMRequest[] = [];
  complete<T>(req: LLMRequest): Promise<T> {
    this.calls.push(req);
    if ('candidates' in (req.schema.properties as object)) {
      return Promise.resolve({ candidates: [{ project: 'old-matcher', why: 'same idea' }, { project: 'made-up-project', why: 'x' }] } as T);
    }
    const r: PriorArt = {
      headline: 'Second DMC matcher.',
      related: [
        { project: 'old-matcher', relation: 'predecessor', reached: 'shipped v0.1', reuse: [
          { path: 'src/dmc.ts', why: 'real file' },
          { path: 'src/', why: 'real folder' },
          { path: 'src/invented.ts', why: 'hallucinated' },
        ] },
        { project: 'made-up-project', relation: 'same-idea', reached: '?', reuse: [] },
      ],
      advice: 'Lift src/dmc.ts.',
    };
    return Promise.resolve(r as T);
  }
}

describe('prior-art check', () => {
  it('keeps only real related projects and real file paths', async () => {
    const root = fixture('prior', {
      'new-matcher/package.json': '{}',
      'new-matcher/index.ts': 'x',
      'old-matcher/package.json': '{}',
      'old-matcher/src/dmc.ts': 'x',
      'unrelated/notes.md': 'x',
    });
    const db = openDb(join(TMP, 'prior.db'));
    await scanFixture(db, root);
    const all = latestProjects(db);
    const target = all.find((p) => p.name === 'new-matcher')!;
    const llm = new Scripted();
    const r = await checkPriorArt(db, llm, 'm', target, all);
    assert.equal(llm.calls.length, 2);
    assert.ok(!llm.calls[0].prompt.includes('- new-matcher:'), 'the new project is not in its own catalog');
    assert.match(llm.calls[1].prompt, /src\/dmc\.ts/, 'stage 2 sees the candidate file list');
    assert.deepEqual(r.related.map((x) => x.project), ['old-matcher']);
    assert.deepEqual(r.related[0].reuse.map((u) => u.path), ['src/dmc.ts', 'src/']);
    assert.deepEqual(getPriorArt(db, target.id)?.result.related.length, 1);
    db.close();
  });
});
