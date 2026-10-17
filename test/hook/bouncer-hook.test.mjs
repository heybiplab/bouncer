// Standalone tests for hooks/bouncer-hook.mjs: runs the hook as Claude Code would (JSON on stdin).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { relativeInside, snapshotId, toPosix } from '../../hooks/bouncer-hook.mjs';

const HOOK = resolve(import.meta.dirname, '../../hooks/bouncer-hook.mjs');

const makeWorkspace = () => realpathSync(mkdtempSync(join(tmpdir(), 'bouncer-test-')));

const preToolUse = (root, toolName, toolInput) => ({
  session_id: 'test-session',
  cwd: root,
  permission_mode: 'default',
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: 'toolu_test',
});

const runHook = (root, input) => {
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  const result = spawnSync(process.execPath, [HOOK], { input: raw, env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
  assert.equal(result.status, 0, 'hook must always exit 0');
  assert.equal(result.stdout.toString(), '', 'hook must print nothing to stdout');
  return result;
};

const runHookAsync = (root, input) =>
  new Promise((done, fail) => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    child.on('error', fail);
    child.on('exit', (code) => done(code));
    child.stdin.end(JSON.stringify(input));
  });

const snapshotsDir = (root) => join(root, '.bouncer', 'snapshots');
const listSnapshots = (root) => (existsSync(snapshotsDir(root)) ? readdirSync(snapshotsDir(root)).sort() : []);
const readMeta = (root, rel) => JSON.parse(readFileSync(join(snapshotsDir(root), `${snapshotId(rel)}.json`), 'utf8'));
const readSnap = (root, rel) => readFileSync(join(snapshotsDir(root), `${snapshotId(rel)}.snap`));
const readState = (root) => JSON.parse(readFileSync(join(root, '.bouncer', 'state.json'), 'utf8'));
const readLog = (root) => readFileSync(join(root, '.bouncer', 'hook.log'), 'utf8');

test('Edit on an existing file snapshots original bytes', () => {
  const root = makeWorkspace();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.ts'), 'original\n');
  runHook(root, preToolUse(root, 'Edit', { file_path: join(root, 'src/a.ts'), old_string: 'original', new_string: 'x' }));

  assert.equal(readSnap(root, 'src/a.ts').toString(), 'original\n');
  const meta = readMeta(root, 'src/a.ts');
  assert.equal(meta.path, 'src/a.ts');
  assert.equal(meta.existed, true);
  assert.ok(!Number.isNaN(Date.parse(meta.createdAt)));
  assert.equal(readState(root).status, 'watching');
  assert.equal(readState(root).sessionId, 'test-session');
});

test('second edit keeps the first (pre-session) original', () => {
  const root = makeWorkspace();
  const file = join(root, 'a.txt');
  writeFileSync(file, 'v1');
  runHook(root, preToolUse(root, 'Edit', { file_path: file }));
  writeFileSync(file, 'v2');
  runHook(root, preToolUse(root, 'Edit', { file_path: file }));

  assert.equal(readSnap(root, 'a.txt').toString(), 'v1');
  assert.deepEqual(listSnapshots(root), [`${snapshotId('a.txt')}.json`, `${snapshotId('a.txt')}.snap`]);
});

test('Write on a new file records existed:false and no .snap', () => {
  const root = makeWorkspace();
  runHook(root, preToolUse(root, 'Write', { file_path: join(root, 'new/dir/file.md'), content: 'hi' }));

  const meta = readMeta(root, 'new/dir/file.md');
  assert.equal(meta.path, 'new/dir/file.md');
  assert.equal(meta.existed, false);
  assert.deepEqual(listSnapshots(root), [`${snapshotId('new/dir/file.md')}.json`]);
});

test('binary files are copied byte-for-byte', () => {
  const root = makeWorkspace();
  const bytes = Buffer.concat([Buffer.from([0x00, 0xff, 0xfe, 0x00]), randomBytes(4096)]);
  writeFileSync(join(root, 'img.bin'), bytes);
  runHook(root, preToolUse(root, 'Write', { file_path: join(root, 'img.bin'), content: '' }));

  assert.ok(readSnap(root, 'img.bin').equals(bytes));
});

test('NotebookEdit uses notebook_path', () => {
  const root = makeWorkspace();
  writeFileSync(join(root, 'nb.ipynb'), '{}');
  runHook(root, preToolUse(root, 'NotebookEdit', { notebook_path: join(root, 'nb.ipynb'), new_source: 'x' }));

  assert.equal(readMeta(root, 'nb.ipynb').existed, true);
});

test('excluded and out-of-workspace paths are never snapshotted', () => {
  const root = makeWorkspace();
  const outside = makeWorkspace();
  writeFileSync(join(outside, 'secret.txt'), 'nope');
  for (const dir of ['.git', 'node_modules/pkg', '.bouncer']) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'f.txt'), 'x');
  }
  symlinkSync(outside, join(root, 'link'));

  const targets = [
    join(outside, 'secret.txt'),
    join(root, '.git/f.txt'),
    join(root, 'node_modules/pkg/f.txt'),
    join(root, '.bouncer/f.txt'),
    join(root, 'link/secret.txt'),
    join(root, 'link/new-file.txt'),
    join(root, '../escape.txt'),
    root,
  ];
  for (const file_path of targets) runHook(root, preToolUse(root, 'Edit', { file_path }));

  assert.deepEqual(listSnapshots(root), []);
  assert.equal(readState(root).status, 'watching');
});

test('malformed JSON exits 0 and logs', () => {
  const root = makeWorkspace();
  runHook(root, '{ not json');
  assert.match(readLog(root), /JSON/);
});

test('missing file path exits 0, logs, and still records watching', () => {
  const root = makeWorkspace();
  runHook(root, preToolUse(root, 'Edit', {}));
  assert.match(readLog(root), /PreToolUse Edit: missing file path/);
  assert.equal(readState(root).status, 'watching');
});

test('non-file tools do not snapshot but mark watching', () => {
  const root = makeWorkspace();
  runHook(root, preToolUse(root, 'Bash', { command: 'ls' }));
  assert.deepEqual(listSnapshots(root), []);
  assert.equal(readState(root).status, 'watching');
});

test('Stop marks state as done', () => {
  const root = makeWorkspace();
  runHook(root, { session_id: 's', cwd: root, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'ok' });
  const state = readState(root);
  assert.equal(state.status, 'done');
  assert.equal(state.sessionId, 's');
  assert.deepEqual(readdirSync(join(root, '.bouncer')), ['state.json']);
});

test('parallel hooks on the same file produce exactly one snapshot pair', async () => {
  const root = makeWorkspace();
  const file = join(root, 'race.txt');
  writeFileSync(file, 'original');
  const input = preToolUse(root, 'Edit', { file_path: file });
  const codes = await Promise.all(Array.from({ length: 10 }, () => runHookAsync(root, input)));

  assert.ok(codes.every((c) => c === 0));
  assert.deepEqual(listSnapshots(root), [`${snapshotId('race.txt')}.json`, `${snapshotId('race.txt')}.snap`]);
  assert.equal(readSnap(root, 'race.txt').toString(), 'original');
  assert.ok(!readdirSync(join(root, '.bouncer'), { recursive: true }).some((f) => f.includes('.tmp-')));
  assert.ok(!existsSync(join(root, '.bouncer', 'hook.log')));
});

test('an in-progress .snap from another hook is never overwritten', () => {
  const root = makeWorkspace();
  writeFileSync(join(root, 'a.txt'), 'already edited');
  mkdirSync(snapshotsDir(root), { recursive: true });
  writeFileSync(join(snapshotsDir(root), `${snapshotId('a.txt')}.snap`), 'true original');
  runHook(root, preToolUse(root, 'Edit', { file_path: join(root, 'a.txt') }));

  assert.equal(readSnap(root, 'a.txt').toString(), 'true original');
  assert.deepEqual(listSnapshots(root), [`${snapshotId('a.txt')}.snap`]);
});

test('a stale orphan .snap (crash leftover) is replaced and committed', () => {
  const root = makeWorkspace();
  writeFileSync(join(root, 'a.txt'), 'current original');
  mkdirSync(snapshotsDir(root), { recursive: true });
  writeFileSync(join(snapshotsDir(root), `${snapshotId('a.txt')}.snap`), 'leftover');
  const result = spawnSync(process.execPath, ['--import', 'data:text/javascript,Date.now=()=>Date.prototype.getTime.call(new Date())+60000', HOOK], {
    input: JSON.stringify(preToolUse(root, 'Edit', { file_path: join(root, 'a.txt') })),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });

  assert.equal(result.status, 0);
  assert.equal(readSnap(root, 'a.txt').toString(), 'current original');
  assert.equal(readMeta(root, 'a.txt').existed, true);
});

test('watching state is not rewritten on every edit of the same session', () => {
  const root = makeWorkspace();
  writeFileSync(join(root, 'a.txt'), 'x');
  runHook(root, preToolUse(root, 'Edit', { file_path: join(root, 'a.txt') }));
  const first = readState(root).updatedAt;
  runHook(root, preToolUse(root, 'Edit', { file_path: join(root, 'a.txt') }));
  assert.equal(readState(root).updatedAt, first);

  runHook(root, { session_id: 'test-session', cwd: root, hook_event_name: 'Stop' });
  assert.equal(readState(root).status, 'done');
  runHook(root, preToolUse(root, 'Edit', { file_path: join(root, 'a.txt') }));
  assert.equal(readState(root).status, 'watching');
});

test('path helpers normalise separators and reject escapes', () => {
  assert.equal(toPosix('src\\views\\a.ts'), 'src/views/a.ts');
  assert.equal(relativeInside('/ws', '/ws/src/a.ts'), 'src/a.ts');
  assert.equal(relativeInside('/ws', '/ws'), null);
  assert.equal(relativeInside('/ws', '/other/a.ts'), null);
  assert.equal(relativeInside('/ws', '/ws/..a/b.ts'), '..a/b.ts');
  assert.equal(relativeInside('/ws', '/ws/a/node_modules/b.js'), null);
});

// --- Shell commands (Bash) -----------------------------------------------------------------------------------

const sh = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout.toString();
};

/** A git repo with a committed file, an uncommitted edit, and an ignored file. */
const makeRepo = () => {
  const root = makeWorkspace();
  sh(root, 'init', '-q');
  sh(root, 'config', 'user.email', 't@example.com');
  sh(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, '.gitignore'), 'secret.env\n');
  writeFileSync(join(root, 'committed.txt'), 'committed\n');
  writeFileSync(join(root, 'gone.txt'), 'will be deleted\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'init');
  writeFileSync(join(root, 'committed.txt'), 'uncommitted edit before Claude\n');
  writeFileSync(join(root, 'untracked.txt'), 'untracked before Claude\n');
  writeFileSync(join(root, 'secret.env'), 'TOKEN=1\n');
  return root;
};

const bashInput = (root, event, toolUseId = 'toolu_bash_1') => ({
  session_id: 'test-session',
  cwd: root,
  hook_event_name: event,
  tool_name: 'Bash',
  tool_input: { command: 'python3 rewrite.py' },
  tool_use_id: toolUseId,
});

test('shell command: modified, created, and deleted files are all tracked with true originals', () => {
  const root = makeRepo();
  const indexBefore = readFileSync(join(root, '.git', 'index'));
  runHook(root, bashInput(root, 'PreToolUse'));

  writeFileSync(join(root, 'committed.txt'), 'changed by shell\n');
  writeFileSync(join(root, 'untracked.txt'), 'untracked changed by shell\n');
  writeFileSync(join(root, 'created.txt'), 'new from shell\n');
  rmSync(join(root, 'gone.txt'));
  writeFileSync(join(root, 'secret.env'), 'TOKEN=2\n');
  runHook(root, bashInput(root, 'PostToolUse'));

  assert.equal(readSnap(root, 'committed.txt').toString(), 'uncommitted edit before Claude\n');
  assert.equal(readSnap(root, 'untracked.txt').toString(), 'untracked before Claude\n');
  assert.equal(readMeta(root, 'created.txt').existed, false);
  assert.equal(readSnap(root, 'gone.txt').toString(), 'will be deleted\n');
  assert.ok(!existsSync(join(snapshotsDir(root), `${snapshotId('secret.env')}.json`)), 'gitignored files are skipped');
  assert.ok(readFileSync(join(root, '.git', 'index')).equals(indexBefore), "the user's staging area is untouched");
  assert.deepEqual(readdirSync(join(root, '.bouncer', 'bash')), ['base.index'], 'per-command files cleaned up');
  assert.ok(!existsSync(join(root, '.bouncer', 'hook.log')));
});

test('shell tracking works when .bouncer/ is gitignored (as Enable sets it up)', () => {
  const root = makeRepo();
  writeFileSync(join(root, '.gitignore'), 'secret.env\n.bouncer/\n');
  runHook(root, bashInput(root, 'PreToolUse'));
  writeFileSync(join(root, 'committed.txt'), 'changed by shell\n');
  runHook(root, bashInput(root, 'PostToolUse'));
  assert.equal(readSnap(root, 'committed.txt').toString(), 'uncommitted edit before Claude\n');
  assert.ok(!existsSync(join(root, '.bouncer', 'hook.log')));
});

test('shell command that changes nothing creates no snapshots', () => {
  const root = makeRepo();
  runHook(root, bashInput(root, 'PreToolUse'));
  runHook(root, bashInput(root, 'PostToolUse'));
  assert.deepEqual(listSnapshots(root), []);
});

test('failed shell command is still tracked (PostToolUseFailure)', () => {
  const root = makeRepo();
  runHook(root, bashInput(root, 'PreToolUse'));
  writeFileSync(join(root, 'committed.txt'), 'half-written\n');
  runHook(root, bashInput(root, 'PostToolUseFailure'));
  assert.equal(readSnap(root, 'committed.txt').toString(), 'uncommitted edit before Claude\n');
});

test('interrupted shell command is picked up at Stop', () => {
  const root = makeRepo();
  runHook(root, bashInput(root, 'PreToolUse'));
  writeFileSync(join(root, 'created.txt'), 'x\n');
  runHook(root, { session_id: 'test-session', cwd: root, hook_event_name: 'Stop' });
  assert.equal(readMeta(root, 'created.txt').existed, false);
  assert.equal(readState(root).status, 'done');
  assert.deepEqual(readdirSync(join(root, '.bouncer', 'bash')), ['base.index']);
});

test('a file already snapshotted by Edit keeps its first original after a shell change', () => {
  const root = makeRepo();
  runHook(root, preToolUse(root, 'Edit', { file_path: join(root, 'committed.txt') }));
  writeFileSync(join(root, 'committed.txt'), 'after Edit\n');
  runHook(root, bashInput(root, 'PreToolUse'));
  writeFileSync(join(root, 'committed.txt'), 'after shell\n');
  runHook(root, bashInput(root, 'PostToolUse'));
  assert.equal(readSnap(root, 'committed.txt').toString(), 'uncommitted edit before Claude\n');
});

test('project in a subfolder of a repo: only its files are tracked, with project-relative paths', () => {
  const repo = makeRepo();
  const root = join(repo, 'app');
  mkdirSync(root);
  writeFileSync(join(root, 'page.tsx'), 'old\n');
  runHook(root, bashInput(root, 'PreToolUse'));
  writeFileSync(join(root, 'page.tsx'), 'new\n');
  writeFileSync(join(repo, 'committed.txt'), 'outside the project\n');
  runHook(root, bashInput(root, 'PostToolUse'));
  assert.deepEqual(listSnapshots(root), [`${snapshotId('page.tsx')}.json`, `${snapshotId('page.tsx')}.snap`]);
  assert.equal(readSnap(root, 'page.tsx').toString(), 'old\n');
});

test('shell command outside a git repo is skipped quietly', () => {
  const root = makeWorkspace();
  writeFileSync(join(root, 'a.txt'), 'x');
  runHook(root, bashInput(root, 'PreToolUse'));
  writeFileSync(join(root, 'a.txt'), 'y');
  runHook(root, bashInput(root, 'PostToolUse'));
  assert.deepEqual(listSnapshots(root), []);
  assert.ok(!existsSync(join(root, '.bouncer', 'hook.log')));
});
