import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { normalizeConfig } from '../src/config.ts';
import { isIgnored, parseGitignore } from '../src/fs/gitignore.ts';
import { ensureDir } from '../src/fs/guard.ts';
import { isSecretPath, listFiles, readTextSafe, SecretFileError } from '../src/fs/read.ts';
import { discover } from '../src/scan/discover.ts';
import { gatherFacts } from '../src/scan/facts.ts';
import { cleanup, fixture } from './helpers.ts';

after(cleanup);

const rels = async (dir: string, isGit: boolean) => (await listFiles(dir, isGit)).files.map((f) => f.rel).sort();

describe('gitignore matcher', () => {
  const rules = parseGitignore(`
# comment
*.log
!keep.log
/generated/
build/
docs/**/*.tmp
secret?.txt
`);
  const cases: [string, boolean, boolean][] = [
    ['app.log', false, true],
    ['a/b/app.log', false, true],
    ['keep.log', false, false],
    ['generated', true, true],
    ['generated/x.ts', false, true],
    ['src/generated', true, false],
    ['build', true, true],
    ['build', false, false],
    ['src/build/out.js', false, true],
    ['docs/a/b/c.tmp', false, true],
    ['docs/c.tmp', false, true],
    ['other/c.tmp', false, false],
    ['secret1.txt', false, true],
    ['secret12.txt', false, false],
    ['src/index.ts', false, false],
  ];
  for (const [path, isDir, expected] of cases) {
    it(`${path}${isDir ? '/' : ''} → ${expected ? 'ignored' : 'kept'}`, () => {
      assert.equal(isIgnored(rules, path, isDir), expected);
    });
  }
});

describe('secret rules', () => {
  const secrets = [
    '.env', '.env.local', '.env.production', '.env.example', '.envrc', 'a/b/.env', 'server.pem', 'tls.key',
    'id_rsa', 'id_ed25519.pub', 'credentials.json', 'secrets.yaml', 'secret', '.npmrc', '.netrc',
    'gcp-service-account-prod.json', 'token.json', '.ssh/config', 'home/.aws/config', 'app.secrets.json', '.dev.vars',
  ];
  const fine = ['src/env.ts', 'environment.md', 'keyboard.ts', 'README.md', 'keys/notes.md', 'src/secretary.ts', 'monkey.png'];
  for (const p of secrets) it(`${p} is secret`, () => assert.equal(isSecretPath(p), true));
  for (const p of fine) it(`${p} is not secret`, () => assert.equal(isSecretPath(p), false));

  it('readTextSafe refuses secrets, including via symlink', () => {
    const dir = fixture('secret-files', { '.env': 'API_KEY=hunter2', 'notes.md': 'hi' });
    assert.throws(() => readTextSafe(join(dir, '.env')), SecretFileError);
    symlinkSync(join(dir, '.env'), join(dir, 'innocent.txt'));
    assert.throws(() => readTextSafe(join(dir, 'innocent.txt')), SecretFileError);
    assert.equal(readTextSafe(join(dir, 'notes.md')), 'hi');
  });
});

const TREE: Record<string, string> = {
  'README.md': '# hi',
  'src/index.ts': '// TODO: one\n// FIXME two',
  'src/app.log': 'log',
  'src/keep.log': 'kept',
  '.gitignore': '*.log\n!keep.log\n/generated/\n',
  'generated/out.ts': 'x',
  'sub/.gitignore': 'local-only.txt\n',
  'sub/local-only.txt': 'x',
  'sub/kept.txt': 'x',
  'node_modules/pkg/index.js': 'x',
  'dist/bundle.js': 'x',
  '.next/cache.json': 'x',
  'target/debug/app': 'x',
  '.venv/lib/x.py': 'x',
  'myenv/pyvenv.cfg': 'home = /usr',
  'myenv/lib/site.py': 'x',
  'Media Cache Files/clip.cfa': 'x',
  '.env': 'SECRET=1',
  '.env.local': 'SECRET=1',
  'config/credentials.json': '{}',
  'certs/server.pem': 'x',
  '.ssh/id_ed25519': 'x',
  '.DS_Store': 'x',
};

describe('scanner ignore rules', () => {
  it('walks non-git folders honoring .gitignore, junk dirs, venvs, media caches and secrets', async () => {
    const dir = fixture('plain', TREE);
    assert.deepEqual(await rels(dir, false), [
      '.gitignore', 'README.md', 'src/index.ts', 'src/keep.log', 'sub/.gitignore', 'sub/kept.txt',
    ]);
  });

  it('uses git for repos and still drops junk and secrets', async () => {
    const dir = fixture('repo', { ...TREE, 'dist/bundle.js': 'tracked build output' });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-f', 'dist/bundle.js'], { cwd: dir }); // tracked junk is still skipped
    const files = await rels(dir, true);
    assert.deepEqual(files.filter((f) => !f.startsWith('myenv/')), [
      '.gitignore', 'README.md', 'src/index.ts', 'src/keep.log', 'sub/.gitignore', 'sub/kept.txt',
    ]);
  });

  it('never follows symlinks out of a project', async () => {
    const dir = fixture('linky', { 'a.txt': 'x' });
    symlinkSync('/etc', join(dir, 'etc-link'));
    assert.deepEqual(await rels(dir, false), ['a.txt']);
  });

  it('counts TODO/FIXME only in readable, non-secret files', async () => {
    const dir = fixture('todos', { 'a.ts': '// TODO x\n// FIXME y', 'b.md': 'TODO', '.env': 'TODO=leak', 'img.png': 'TODO' });
    const facts = await gatherFacts({ path: dir, name: 'todos', root: dir, isGit: false }, true, { maxFiles: 100, skipDirs: new Set() });
    assert.equal(facts.todoCount, 3);
  });
});

describe('discovery', () => {
  it('finds repos, expands containers, keeps creative folders, skips excluded and junk', () => {
    const root = fixture('root', {
      'loose-file.wav': 'x',
      'app/package.json': '{}',
      'container/one/Cargo.toml': '',
      'container/two/pyproject.toml': '',
      'container/sketches/a.psd': 'x',
      'photos/a.jpg': 'x',
      'Adobe/prefs.txt': 'x',
      'node_modules/x/package.json': '{}',
      '.hidden/package.json': '{}',
    });
    ensureDir(join(root, 'empty'));
    execFileSync('git', ['init', '-q', join(root, 'repo')]);
    const config = normalizeConfig({ roots: [{ path: root, exclude: ['Adobe'] }] });
    const names = discover(config, { self: '/nonexistent-manager-root' }).map((c) => c.path.slice(root.length + 1)).sort();
    assert.deepEqual(names, ['app', 'container/one', 'container/sketches', 'container/two', 'photos', 'repo']);
  });
});
