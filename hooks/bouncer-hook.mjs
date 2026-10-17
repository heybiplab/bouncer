// Claude Code hook: snapshots files before Claude changes them (file tools and shell commands) and records session state.
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOUNCER_DIR = '.bouncer';
const SNAPSHOTS_DIR = 'snapshots';
const BASH_DIR = 'bash';
const BASE_INDEX = 'base.index';
const STATE_FILE = 'state.json';
const LOG_FILE = 'hook.log';
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOL = 'Bash';
const EXCLUDED_SEGMENTS = new Set([BOUNCER_DIR, '.git', 'node_modules']);
const SKIPPED_GIT_MODES = new Set(['120000', '160000']); // symlinks and submodules
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

/** Converts any path separators to forward slashes. */
export const toPosix = (p) => p.replace(/\\/g, '/');

/** Returns true when the relative path contains an excluded folder segment. */
export const hasExcludedSegment = (relPosix) => relPosix.split('/').some((seg) => EXCLUDED_SEGMENTS.has(seg));

/** Pure check: maps an absolute path to a workspace-relative POSIX path, or null if it must not be snapshotted. */
export const relativeInside = (root, absPath) => {
  const rel = relative(root, absPath);
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  const relPosix = toPosix(rel);
  return hasExcludedSegment(relPosix) ? null : relPosix;
};

/** Resolves symlinks for a path that may not exist yet, via its nearest existing ancestor. */
const realpathLoose = (absPath) => {
  const tail = [];
  let current = absPath;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absPath;
    tail.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync.native(current), ...tail);
};

/** Maps a tool's target path to a workspace-relative POSIX path, or null if out of bounds. */
export const toWorkspaceRelative = (root, filePath) => relativeInside(root, realpathLoose(resolve(root, filePath)));

/** Stable snapshot id derived from the relative path, so each file gets at most one snapshot. */
export const snapshotId = (relPosix) => createHash('sha1').update(relPosix).digest('hex');

const bouncerPath = (root, ...parts) => join(root, BOUNCER_DIR, ...parts);

const readInput = () => JSON.parse(readFileSync(0, 'utf8'));

const resolveRoot = (input) => realpathSync.native(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());

/** Writes a file atomically (temp file + rename) so readers never see partial content. */
const writeAtomic = (target, data) => {
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, target);
};

const readJsonFile = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const isAlreadyExists = (err) => err?.code === 'EEXIST';

// ---------------------------------------------------------------------------------------------------------------
// Snapshot storage (shared by file tools and shell commands)
// ---------------------------------------------------------------------------------------------------------------

/** A .snap without its .json that is older than this was left by a crash, not by a hook still running. */
const ORPHAN_AGE_MS = 5000;

const isOrphan = (snapPath, metaPath) =>
  !existsSync(metaPath) && Date.now() - statSync(snapPath).ctimeMs > ORPHAN_AGE_MS;

/**
 * Writes the original bytes exclusively, so a slower parallel hook can never overwrite them with
 * already-edited content. `write(exclusive)` performs the write. Returns false if another hook owns it.
 */
const claimSnap = (snapPath, metaPath, write) => {
  try {
    write(true);
    return true;
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
  if (!isOrphan(snapPath, metaPath)) return false;
  write(false);
  return true;
};

/**
 * Records a file's pre-session original, unless one is already recorded. `writeOriginal(snapPath, exclusive)`
 * writes the original bytes; pass null for a file that did not exist (Undo will delete it).
 */
const saveSnapshot = (root, relPosix, writeOriginal) => {
  const dir = bouncerPath(root, SNAPSHOTS_DIR);
  const id = snapshotId(relPosix);
  const metaPath = join(dir, `${id}.json`);
  if (existsSync(metaPath)) return;

  mkdirSync(dir, { recursive: true });
  const snapPath = join(dir, `${id}.snap`);
  if (writeOriginal && !claimSnap(snapPath, metaPath, (exclusive) => writeOriginal(snapPath, exclusive))) return;

  const meta = { path: relPosix, existed: writeOriginal !== null, createdAt: new Date().toISOString() };
  try {
    // The meta file is the commit marker: written last, exclusively, so parallel hooks cannot both claim it.
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
};

// ---------------------------------------------------------------------------------------------------------------
// File tools (Write, Edit, ...): the target path is known up front
// ---------------------------------------------------------------------------------------------------------------

const snapshotFileTool = (root, input) => {
  const filePath = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof filePath !== 'string' || filePath === '') throw new Error(`${input.tool_name}: missing file path`);

  const relPosix = toWorkspaceRelative(root, filePath);
  if (!relPosix) return;

  const abs = join(root, relPosix);
  const stat = statSync(abs, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) return;

  const copyFrom = (snapPath, exclusive) => copyFileSync(abs, snapPath, exclusive ? constants.COPYFILE_EXCL : 0);
  saveSnapshot(root, relPosix, stat ? copyFrom : null);
};

// ---------------------------------------------------------------------------------------------------------------
// Shell commands (Bash): any file may change, so compare the project before and after the command.
// The project state is captured as a git tree using a private index file, so the user's staging area,
// branches, and history are never touched. Projects that are not git repositories are skipped quietly.
// ---------------------------------------------------------------------------------------------------------------

class NotARepo extends Error {}

const git = (root, args, indexFile) => {
  const env = indexFile ? { ...process.env, GIT_INDEX_FILE: indexFile } : process.env;
  const result = spawnSync('git', args, { cwd: root, env, maxBuffer: GIT_MAX_BUFFER });
  if (result.error) throw result.error.code === 'ENOENT' ? new NotARepo() : result.error;
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout;
};

/**
 * Captures the project folder as a git tree: respects .gitignore and only re-reads changed files.
 * (.bouncer is not excluded with a pathspec: git rejects that once .bouncer is gitignored. It is normally
 * ignored, and its paths are skipped when diffing anyway.)
 */
const captureTree = (root, indexFile) => {
  git(root, ['add', '--all', '--', '.'], indexFile);
  return git(root, ['write-tree'], indexFile).toString().trim();
};

/**
 * Where the project sits in its repository: `prefix` is the project folder relative to the repository root
 * (empty at the root), `index` is the real index (only ever read, to seed the first capture).
 * Returns null outside a git repository or when git is not installed.
 */
const gitInfo = (root) => {
  const result = spawnSync('git', ['rev-parse', '--show-prefix', '--git-path', 'index'], { cwd: root });
  if (result.error || result.status !== 0) return null;
  const [prefix = '', index = ''] = result.stdout.toString().split('\n');
  return { prefix, index: resolve(root, index) };
};

/**
 * Seeds a private index. Reusing the last capture (base.index) lets git skip unchanged files by their
 * timestamps, so each capture only reads what changed. The real index is the fallback seed.
 */
const seedIndex = (root, info, indexFile) => {
  const base = bouncerPath(root, BASH_DIR, BASE_INDEX);
  const seed = existsSync(base) ? base : info.index;
  if (existsSync(seed)) copyFileSync(seed, indexFile);
};

const safeId = (value) => String(value ?? `${process.pid}-${Date.now()}`).replace(/[^\w-]/g, '_');

const capturePaths = (root, toolUseId) => {
  const id = safeId(toolUseId);
  return { record: bouncerPath(root, BASH_DIR, `${id}.json`), index: bouncerPath(root, BASH_DIR, `${id}.index`) };
};

/** Before a shell command: capture the project and remember the tree for this tool call. */
const beginShellCapture = (root, input) => {
  const { record, index } = capturePaths(root, input.tool_use_id);
  mkdirSync(dirname(record), { recursive: true });
  try {
    const info = gitInfo(root);
    if (!info) return;
    seedIndex(root, info, index);
    writeAtomic(record, JSON.stringify({ tree: captureTree(root, index), index, prefix: info.prefix }));
  } catch (err) {
    rmSync(index, { force: true });
    if (!(err instanceof NotARepo)) throw err;
  }
};

/** Parses `git diff-tree -z --raw` output into { status, path, oldMode, newMode, oldBlob }. */
export const parseRawDiff = (buffer) => {
  const parts = buffer.toString('utf8').split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode, newMode, oldBlob, , status] = parts[i].slice(1).split(' ');
    if (status) entries.push({ status: status[0], path: parts[i + 1], oldMode, newMode, oldBlob });
  }
  return entries;
};

/**
 * Saves originals for every file that differs between two trees. `--relative` limits the diff to the project
 * folder and gives project-relative paths. `--filters` turns stored blobs back into exact working-tree bytes
 * (line endings, LFS); it needs the repository-relative path, hence the prefix.
 */
const snapshotTreeChanges = (root, prefix, before, after) => {
  const raw = git(root, ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--relative', before, after]);
  for (const { status, path, oldMode, newMode, oldBlob } of parseRawDiff(raw)) {
    if (SKIPPED_GIT_MODES.has(oldMode) || SKIPPED_GIT_MODES.has(newMode) || hasExcludedSegment(path)) continue;
    const original = () => git(root, ['cat-file', '--filters', `--path=${prefix}${path}`, oldBlob]);
    const writeBlob = (snapPath, exclusive) => writeFileSync(snapPath, original(), { flag: exclusive ? 'wx' : 'w' });
    saveSnapshot(root, path, status === 'A' ? null : writeBlob);
  }
};

/** After a shell command: compare with the capture taken before it, then clean up. */
const finishShellCapture = (root, record) => {
  const capture = readJsonFile(record);
  try {
    if (!capture?.tree || !existsSync(capture.index)) return;
    const after = captureTree(root, capture.index);
    if (after !== capture.tree) snapshotTreeChanges(root, capture.prefix ?? '', capture.tree, after);
    renameSync(capture.index, bouncerPath(root, BASH_DIR, BASE_INDEX));
  } finally {
    rmSync(record, { force: true });
    if (capture?.index) rmSync(capture.index, { force: true });
  }
};

/** At Stop: finish captures whose "after" hook never ran (e.g. the command was interrupted). */
const finishLeftoverCaptures = (root) => {
  const dir = bouncerPath(root, BASH_DIR);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    finishShellCapture(root, join(dir, name));
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Session state and logging
// ---------------------------------------------------------------------------------------------------------------

/**
 * Records the session status for the extension. `watching` is only rewritten when it actually changes,
 * so repeated edits don't wake the extension's file watcher for nothing. `done` is always written:
 * its new timestamp is what triggers the "Claude finished" notification.
 */
const writeState = (root, status, input) => {
  const sessionId = input.session_id ?? null;
  if (status === 'watching') {
    const current = readJsonFile(bouncerPath(root, STATE_FILE));
    if (current?.status === status && current?.sessionId === sessionId) return;
  }
  mkdirSync(bouncerPath(root), { recursive: true });
  const state = { status, updatedAt: new Date().toISOString(), sessionId };
  writeAtomic(bouncerPath(root, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
};

/** Appends one line to .bouncer/hook.log; never throws. */
const logError = (root, event, err) => {
  try {
    const base = root ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    mkdirSync(bouncerPath(base), { recursive: true });
    const message = err instanceof Error ? err.message : String(err);
    appendFileSync(bouncerPath(base, LOG_FILE), `${new Date().toISOString()} ${event ?? 'unknown'} ${message}\n`);
  } catch {
    // Logging must never break Claude.
  }
};

const afterTool = (root, input) => {
  if (input.tool_name === SHELL_TOOL) finishShellCapture(root, capturePaths(root, input.tool_use_id).record);
};

const handlers = {
  PreToolUse: (root, input) => {
    try {
      if (FILE_TOOLS.has(input.tool_name)) snapshotFileTool(root, input);
      else if (input.tool_name === SHELL_TOOL) beginShellCapture(root, input);
    } finally {
      writeState(root, 'watching', input);
    }
  },
  PostToolUse: afterTool,
  PostToolUseFailure: afterTool,
  Stop: (root, input) => {
    try {
      finishLeftoverCaptures(root);
    } finally {
      writeState(root, 'done', input);
    }
  },
};

const main = () => {
  let root;
  let event;
  try {
    const input = readInput();
    event = input.hook_event_name;
    root = resolveRoot(input);
    handlers[event]?.(root, input);
  } catch (err) {
    logError(root, event, err);
  }
  process.exit(0);
};

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
