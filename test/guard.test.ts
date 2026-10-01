import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  appendText, assertWritable, ensureDir, openDatabase, remove, writeJson, writeText, WriteGuardError,
} from '../src/fs/guard.ts';
import { DATA_DIR, ROOT } from '../src/paths.ts';
import { cleanup, TMP } from './helpers.ts';

after(cleanup);

const refused = (fn: () => unknown) => assert.throws(fn, WriteGuardError);

describe('write guard', () => {
  it('allows writes inside data/', () => {
    const file = join(TMP, 'ok', 'nested', 'a.txt');
    writeText(file, 'hello');
    appendText(file, ' world');
    assert.equal(readFileSync(file, 'utf8'), 'hello world');
    writeJson(join(TMP, 'ok', 'b.json'), { a: 1 });
    const db = openDatabase(join(TMP, 'ok', 'x.db'));
    db.exec('CREATE TABLE t (x)');
    db.close();
  });

  // Destructive calls only ever target paths that don't exist, so a broken guard can't do damage.
  // Real paths are checked with assertWritable, which has no side effects.
  it('refuses absolute paths outside data/', () => {
    const missing = [
      join(homedir(), 'Documents', 'manager-guard-test-nonexistent.txt'),
      join(homedir(), 'manager-guard-test-nonexistent.txt'),
      join(tmpdir(), 'manager-guard-test-nonexistent.txt'),
      join(ROOT, 'src', 'manager-guard-test-nonexistent.ts'),
      '/etc/manager-guard-test-nonexistent',
    ];
    for (const p of missing) {
      assert.equal(existsSync(p), false);
      refused(() => writeText(p, 'x'));
      refused(() => appendText(p, 'x'));
      refused(() => ensureDir(p));
      refused(() => remove(p));
      refused(() => openDatabase(p));
      assert.equal(existsSync(p), false);
    }
    for (const p of ['/', homedir(), join(homedir(), 'Documents'), ROOT, join(ROOT, 'package.json')]) {
      refused(() => assertWritable(p));
      refused(() => assertWritable(p, { allowDataRoot: true }));
    }
  });

  it('refuses traversal out of data/', () => {
    refused(() => writeText(join(DATA_DIR, '..', 'evil.txt'), 'x'));
    refused(() => writeText(join(TMP, '..', '..', '..', 'evil.txt'), 'x'));
    refused(() => writeText(`${DATA_DIR}/a/../../evil.txt`, 'x'));
    refused(() => writeText(relative(process.cwd(), join(ROOT, 'evil.txt')), 'x'));
  });

  it('refuses sibling directories that share the data/ prefix', () => {
    refused(() => writeText(join(ROOT, 'data-evil', 'x.txt'), 'x'));
    refused(() => writeText(DATA_DIR + 'x', 'x'));
  });

  it('refuses writing to or deleting data/ itself', () => {
    refused(() => assertWritable(DATA_DIR));
    assert.doesNotThrow(() => ensureDir(DATA_DIR));
  });

  it('refuses symlink escapes', () => {
    const dir = ensureDir(join(TMP, 'links'));
    symlinkSync(homedir(), join(dir, 'home'));
    assert.equal(existsSync(join(homedir(), 'manager-guard-test.txt')), false);
    refused(() => writeText(join(dir, 'home', 'manager-guard-test.txt'), 'x'));
    refused(() => ensureDir(join(dir, 'home', 'manager-guard-test-dir')));
    refused(() => assertWritable(join(dir, 'home', 'Documents')));
    assert.equal(existsSync(join(homedir(), 'manager-guard-test.txt')), false);
    assert.equal(existsSync(join(homedir(), 'manager-guard-test-dir')), false);

    symlinkSync(join(ROOT, 'package.json'), join(dir, 'file-link'));
    refused(() => assertWritable(join(dir, 'file-link')));

    symlinkSync('/nonexistent/manager-target', join(dir, 'dangling'));
    refused(() => writeText(join(dir, 'dangling'), 'x'));
  });

  it('refuses null bytes', () => {
    refused(() => assertWritable(join(TMP, 'a\0b')));
  });
});

describe('write surface', () => {
  // Only guard.ts may touch fs write APIs or open a database.
  const WRITE_API = /\b(writeFile|appendFile|mkdir|mkdtemp|rmdir|rm|unlink|rename|copyFile|cp|symlink|link|chmod|chown|truncate|utimes|createWriteStream|open)(Sync)?\s*\(|DatabaseSync\s*\(|fs\/promises|['"]node:fs['"][^;]*\bpromises\b/;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
  }

  it('no module except src/fs/guard.ts can write', () => {
    const offenders = sourceFiles(join(ROOT, 'src'))
      .filter((f) => !f.endsWith(join('src', 'fs', 'guard.ts')))
      .filter((f) => {
        const text = readFileSync(f, 'utf8');
        // read.ts legitimately uses openSync(…, 'r'); anything else opening files is a violation.
        const withoutReadOpen = text.replace(/openSync\(\s*\w+\s*,\s*'r'\s*\)/g, '');
        return WRITE_API.test(withoutReadOpen);
      })
      .map((f) => relative(ROOT, f));
    assert.deepEqual(offenders, []);
  });
});
