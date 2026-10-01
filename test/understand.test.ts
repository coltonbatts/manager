import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { openDb } from '../src/db.ts';
import { writeText } from '../src/fs/guard.ts';
import { parseCliOutput } from '../src/llm/claude-cli.ts';
import { LLMError, type LLMProvider, type LLMRequest } from '../src/llm/provider.ts';
import { latestProjects } from '../src/store.ts';
import { buildDigest } from '../src/understand/digest.ts';
import { synthesizePortfolio } from '../src/understand/portfolio.ts';
import { getProfile, refreshProfiles, type Profile } from '../src/understand/profile.ts';
import { redact } from '../src/understand/redact.ts';
import { cleanup, fixture, scanFixture as scanWithSelf, TMP } from './helpers.ts';

after(cleanup);

class FakeProvider implements LLMProvider {
  readonly name = 'fake';
  calls: LLMRequest[] = [];
  complete<T>(req: LLMRequest): Promise<T> {
    this.calls.push(req);
    if ('headline' in (req.schema.properties as object)) {
      return Promise.resolve({
        headline: 'h', active: [], closeToShipping: [], stalled: [], quietlyAbandoned: [], overlaps: [], observations: [],
        suggestedFocus: { project: 'alpha', why: 'because' },
      } as T);
    }
    const profile: Profile = {
      summary: 's', category: 'tool', stage: 'building', currentState: 'c', nextStep: 'n', risks: [], closeness: 'midway', confidence: 'low',
    };
    return Promise.resolve(profile as T);
  }
}

describe('redaction', () => {
  const cases: [string, string][] = [
    ['key sk-ant-api03-abcdefghijklmnopqrstuv end', 'key [REDACTED] end'],
    ['STRIPE_SECRET_KEY=sk_live_abcdefghij1234', 'STRIPE_SECRET_KEY=[REDACTED]'],
    ['token: ghp_abcdefghijklmnopqrstuvwxyz123456', 'token: [REDACTED]'],
    ['aws AKIAABCDEFGHIJKLMNOP', 'aws [REDACTED]'],
    ['postgres://user:hunter22@db.example.com/x', '[REDACTED]db.example.com/x'],
    ['password = "correct-horse"', 'password = "[REDACTED]"'],
    ['-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', '[REDACTED]'],
  ];
  for (const [input, expected] of cases) it(`scrubs ${input.slice(0, 24)}…`, () => assert.equal(redact(input), expected));
  it('leaves ordinary prose alone', () => {
    const s = 'Add a token bucket rate limiter and rotate the password reset flow.';
    assert.equal(redact(s), s);
  });
});

describe('claude -p output parsing', () => {
  it('prefers structured_output', () => {
    assert.deepEqual(parseCliOutput(JSON.stringify({ type: 'result', result: 'x', structured_output: { a: 1 } })), { a: 1 });
  });
  it('falls back to JSON inside result, with or without fences', () => {
    assert.deepEqual(parseCliOutput(JSON.stringify({ result: '```json\n{"a": 2}\n```' })), { a: 2 });
    assert.deepEqual(parseCliOutput(JSON.stringify({ result: 'Here: {"a": 3}' })), { a: 3 });
  });
  it('raises on errors and garbage', () => {
    assert.throws(() => parseCliOutput(JSON.stringify({ is_error: true, result: 'auth failed' })), LLMError);
    assert.throws(() => parseCliOutput('not json'), LLMError);
    assert.throws(() => parseCliOutput(JSON.stringify({ result: 'no json here' })), LLMError);
  });
});

describe('profiles', () => {
  it('digest never includes secret files or raw credentials', async () => {
    const dir = join(fixture('digest', {
      'proj/README.md': '# Proj\nSet OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx in your shell.',
      'proj/.env': 'DATABASE_PASSWORD=supersecretvalue',
      'proj/credentials.json': '{"private": "zzz-credential-zzz"}',
      'proj/package.json': '{"name": "proj", "dependencies": {"react": "1"}}',
    }), 'proj');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const db = openDb(join(TMP, 'digest', 'm.db'));
    await scanWithSelf(db, join(TMP, 'digest'));
    const [p] = latestProjects(db);
    const digest = await buildDigest(p);
    assert.match(digest, /# Proj/);
    assert.doesNotMatch(digest, /supersecretvalue|zzz-credential-zzz|sk-abcdefghij/);
    assert.doesNotMatch(digest, /\.env|credentials\.json/);
    db.close();
  });

  it('caches by fingerprint and re-profiles only what changed', async () => {
    const root = join(TMP, 'cache');
    fixture('cache', { 'alpha/a.ts': 'x', 'beta/b.ts': 'x' });
    const db = openDb(join(root, 'm.db'));
    const llm = new FakeProvider();

    await scanWithSelf(db, root);
    let r = await refreshProfiles(db, llm, 'm', latestProjects(db), { concurrency: 2 });
    assert.deepEqual([r.generated, r.cached], [2, 0]);

    r = await refreshProfiles(db, llm, 'm', latestProjects(db), { concurrency: 2 });
    assert.deepEqual([r.generated, r.cached], [0, 2]);

    writeText(join(root, 'alpha', 'new.ts'), 'changed');
    await scanWithSelf(db, root);
    r = await refreshProfiles(db, llm, 'm', latestProjects(db), { concurrency: 2 });
    assert.deepEqual([r.generated, r.cached], [1, 1]);
    assert.equal(llm.calls.length, 3);
    for (const p of latestProjects(db)) assert.equal(getProfile(db, p)?.fresh, true);

    await synthesizePortfolio(db, llm, 'm', latestProjects(db));
    const again = await synthesizePortfolio(db, llm, 'm', latestProjects(db));
    assert.equal(again.cached, true);
    assert.equal(llm.calls.length, 4);
    db.close();
  });
});
