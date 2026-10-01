import assert from 'node:assert/strict';
import { request } from 'node:http';
import { describe, it } from 'node:test';
import { html, raw } from '../src/web/html.ts';
import { startServer } from '../src/web/server.ts';
import { strip } from '../src/web/views.ts';

describe('html escaping', () => {
  it('escapes interpolations, keeps raw and nested html', () => {
    const name = '<script>alert("x")</script>';
    const out = html`<h1>${name}</h1>${raw('<hr>')}${[html`<i>${'&'}</i>`, 'b']}`.value;
    assert.equal(out, '<h1>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</h1><hr><i>&amp;</i>b');
  });
  it('drops null, undefined and false', () => {
    assert.equal(html`${null}${undefined}${false}${0}`.value, '0');
  });
  it('renders one tick per week', () => {
    assert.equal((strip([0, 1, 7, 3]).value.match(/<rect/g) ?? []).length, 4);
  });
});

function call(port: number, opts: { method?: string; host?: string; origin?: string; body?: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: opts.method === 'POST' ? '/journal' : '/', method: opts.method ?? 'GET',
      headers: { host: opts.host ?? `127.0.0.1:${port}`, ...(opts.origin ? { origin: opts.origin } : {}), 'content-type': 'application/x-www-form-urlencoded' },
    }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end(opts.body ?? '');
  });
}

describe('server request guards', () => {
  // Only the rejection paths are exercised: they return before touching any database.
  it('refuses foreign Host headers (DNS rebinding) and cross-site posts', async () => {
    const port = 47000 + (process.pid % 1000);
    const server = await startServer(port);
    assert.equal(await call(port, { host: 'evil.example' }), 403);
    assert.equal(await call(port, { host: `evil.example:${port}` }), 403);
    assert.equal(await call(port, { method: 'POST', origin: 'https://evil.example', body: 'text=x' }), 403);
    assert.equal(await call(port, { method: 'DELETE' }), 405);
    server.close();
  });
});
