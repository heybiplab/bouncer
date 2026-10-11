// Claude Code hook (PreToolUse + Stop): snapshots files before Claude edits them and records session state.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOUNCER_DIR = '.bouncer';
const SNAPSHOTS_DIR = 'snapshots';
const STATE_FILE = 'state.json';
const LOG_FILE = 'hook.log';
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const EXCLUDED_SEGMENTS = new Set([BOUNCER_DIR, '.git', 'node_modules']);

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
  return join(realpathSync(current), ...tail);
};

/** Maps a tool's target path to a workspace-relative POSIX path, or null if out of bounds. */
export const toWorkspaceRelative = (root, filePath) => relativeInside(root, realpathLoose(resolve(root, filePath)));

/** Stable snapshot id derived from the relative path, so each file gets at most one snapshot. */
export const snapshotId = (relPosix) => createHash('sha1').update(relPosix).digest('hex');

const bouncerPath = (root, ...parts) => join(root, BOUNCER_DIR, ...parts);

const readInput = () => JSON.parse(readFileSync(0, 'utf8'));

const resolveRoot = (input) => realpathSync(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());

/** Writes a file atomically (temp file + rename) so readers never see partial content. */
const writeAtomic = (target, data) => {
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, target);
};

const isAlreadyExists = (err) => err?.code === 'EEXIST';

/** Saves the original file content the first time Claude touches a file. */
const snapshotIfNeeded = (root, input) => {
  if (!FILE_TOOLS.has(input.tool_name)) return;
  const filePath = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof filePath !== 'string' || filePath === '') throw new Error(`${input.tool_name}: missing file path`);

  const relPosix = toWorkspaceRelative(root, filePath);
  if (!relPosix) return;

  const dir = bouncerPath(root, SNAPSHOTS_DIR);
  const id = snapshotId(relPosix);
  const metaPath = join(dir, `${id}.json`);
  if (existsSync(metaPath)) return;

  const abs = join(root, relPosix);
  const stat = existsSync(abs) ? statSync(abs) : null;
  if (stat && !stat.isFile()) return;

  mkdirSync(dir, { recursive: true });
  if (stat) {
    const tmp = join(dir, `${id}.snap.tmp-${process.pid}`);
    copyFileSync(abs, tmp);
    renameSync(tmp, join(dir, `${id}.snap`));
  }

  const meta = { path: relPosix, existed: Boolean(stat), createdAt: new Date().toISOString() };
  try {
    // The meta file is the commit marker: written last, exclusively, so parallel hooks cannot both claim it.
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
};

/** Records the current session status for the extension to watch. */
const writeState = (root, status, input) => {
  mkdirSync(bouncerPath(root), { recursive: true });
  const state = { status, updatedAt: new Date().toISOString(), sessionId: input.session_id ?? null };
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

const handlers = {
  PreToolUse: (root, input) => {
    try {
      snapshotIfNeeded(root, input);
    } finally {
      writeState(root, 'watching', input);
    }
  },
  Stop: (root, input) => writeState(root, 'done', input),
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
