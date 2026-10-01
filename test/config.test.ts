import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { modelFor, normalizeConfig } from '../src/config.ts';

describe('model routing', () => {
  it('falls back to the per-project and report defaults', () => {
    const { llm } = normalizeConfig({ llm: { model: 'sonnet', reportModel: 'opus' } });
    for (const t of ['profile', 'reentry', 'prior-art', 'prior-art-scan'] as const) assert.equal(modelFor(llm, t), 'sonnet');
    for (const t of ['portfolio', 'patterns', 'checkin'] as const) assert.equal(modelFor(llm, t), 'opus');
  });

  it('lets one task override its default', () => {
    const { llm } = normalizeConfig({ llm: { models: { profile: 'haiku', checkin: 'sonnet' } } });
    assert.equal(modelFor(llm, 'profile'), 'haiku');
    assert.equal(modelFor(llm, 'reentry'), 'sonnet');
    assert.equal(modelFor(llm, 'checkin'), 'sonnet');
    assert.equal(modelFor(llm, 'portfolio'), 'opus');
  });

  it('rejects unknown tasks so a typo does not silently route to the default', () => {
    assert.throws(() => normalizeConfig({ llm: { models: { profil: 'haiku' } as never } }), /unknown task "profil"/);
  });
});
