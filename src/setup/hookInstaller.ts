// Adds, removes, and repairs Bouncer's hook entries in the project's .claude/settings.local.json.
import * as vscode from 'vscode';
import {
  CLAUDE_DIR,
  CLAUDE_LOCAL_SETTINGS_FILE,
  CLAUDE_SETTINGS_FILE,
  GITIGNORE_ENTRIES,
  GITIGNORE_FILE,
  HOOK_MATCHER,
  SHELL_MATCHER,
  HOOK_SCRIPT_DIR,
  HOOK_SCRIPT_FILE,
  HOOK_TIMEOUT_SECONDS,
  BOUNCER_DIR,
  STATE_FILE,
} from '../constants';
import type { BouncerState, ClaudeSettings, HookHandler, HookMatcherGroup, HooksConfig } from '../types';
import { exists, readTextOrNull, writeJson, writeText } from '../utils/fs';

const PRE_TOOL_USE = 'PreToolUse';
const POST_TOOL_USE = 'PostToolUse';
const POST_TOOL_USE_FAILURE = 'PostToolUseFailure';
const STOP = 'Stop';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Bouncer's handlers are recognised by the script name, so they survive path changes between versions. */
const isBouncerHandler = (handler: HookHandler): boolean =>
  isRecord(handler) && typeof handler.command === 'string' && handler.command.includes(HOOK_SCRIPT_FILE);

/** Absolute path of the hook script bundled with this extension version. */
export const hookScriptPath = (extensionUri: vscode.Uri): string =>
  vscode.Uri.joinPath(extensionUri, HOOK_SCRIPT_DIR, HOOK_SCRIPT_FILE).fsPath;

export const buildHookCommand = (scriptPath: string): string => `node "${scriptPath}"`;

/**
 * The handler Bouncer expects for each event. Tool hooks stay synchronous: originals must be saved before
 * Claude edits, and shell changes must be recorded before Claude finishes. Stop only updates state.json and
 * never controls Claude, so it runs in the background (`async: true`) and Claude doesn't wait for it.
 */
const bouncerHandler = (event: string, command: string): HookHandler => ({
  type: 'command',
  command,
  timeout: HOOK_TIMEOUT_SECONDS,
  ...(event === STOP ? { async: true } : {}),
});

/** Applies `fn` to every handler list, dropping groups and events that end up empty. */
const mapHandlers = (settings: ClaudeSettings, fn: (handlers: HookHandler[]) => HookHandler[]): ClaudeSettings => {
  const { hooks, ...rest } = settings;
  if (!isRecord(hooks)) {
    return settings;
  }
  const nextHooks: HooksConfig = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      nextHooks[event] = groups;
      continue;
    }
    const nextGroups = groups
      .map((group: HookMatcherGroup) => (Array.isArray(group?.hooks) ? { ...group, hooks: fn(group.hooks) } : group))
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (nextGroups.length > 0) {
      nextHooks[event] = nextGroups;
    }
  }
  return Object.keys(nextHooks).length > 0 ? { ...rest, hooks: nextHooks } : rest;
};

export const isBouncerEnabled = (settings: ClaudeSettings): boolean =>
  isRecord(settings.hooks) &&
  Object.values(settings.hooks).some(
    (groups) => Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isBouncerHandler)),
  );

export const removeBouncerHooks = (settings: ClaudeSettings): ClaudeSettings =>
  mapHandlers(settings, (handlers) => handlers.filter((h) => !isBouncerHandler(h)));

export const addBouncerHooks = (settings: ClaudeSettings, command: string): ClaudeSettings => {
  const cleaned = removeBouncerHooks(settings);
  const hooks: HooksConfig = isRecord(cleaned.hooks) ? { ...cleaned.hooks } : {};
  const append = (event: string, group: HookMatcherGroup) => {
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), group];
  };
  // Before file tools and shell commands; after shell commands (succeeded or failed) to see what they changed.
  append(PRE_TOOL_USE, { matcher: HOOK_MATCHER, hooks: [bouncerHandler(PRE_TOOL_USE, command)] });
  append(POST_TOOL_USE, { matcher: SHELL_MATCHER, hooks: [bouncerHandler(POST_TOOL_USE, command)] });
  append(POST_TOOL_USE_FAILURE, { matcher: SHELL_MATCHER, hooks: [bouncerHandler(POST_TOOL_USE_FAILURE, command)] });
  append(STOP, { hooks: [bouncerHandler(STOP, command)] });
  return { ...cleaned, hooks };
};

/** Compares .gitignore lines without a leading or trailing slash (`.bouncer`, `/.bouncer/`, ...). */
const normalizeIgnoreLine = (line: string): string => line.trim().replace(/^\//, '').replace(/\/$/, '');

/** Appends any missing entries to .gitignore content; returns null when nothing is missing. */
export const withGitignoreEntries = (content: string, entries: readonly string[]): string | null => {
  const present = new Set(content.split(/\r?\n/).map(normalizeIgnoreLine));
  const missing = entries.filter((entry) => !present.has(normalizeIgnoreLine(entry)));
  if (missing.length === 0) {
    return null;
  }
  const separator = content === '' || content.endsWith('\n') ? '' : '\n';
  return `${content}${separator}${missing.join('\n')}\n`;
};

/**
 * Bouncer writes its hooks to the personal, uncommitted settings.local.json: the hook path points into this
 * machine's extension folder, so it must never reach teammates through the shared settings.json.
 */
const settingsFiles = (root: vscode.Uri) => ({
  local: vscode.Uri.joinPath(root, CLAUDE_DIR, CLAUDE_LOCAL_SETTINGS_FILE),
  shared: vscode.Uri.joinPath(root, CLAUDE_DIR, CLAUDE_SETTINGS_FILE),
});

/** Reads a settings file; missing means `{}`. Invalid JSON throws so we never overwrite the user's file. */
const readSettings = async (uri: vscode.Uri): Promise<ClaudeSettings> => {
  const label = `${CLAUDE_DIR}/${uri.path.slice(uri.path.lastIndexOf('/') + 1)}`;
  const text = await readTextOrNull(uri);
  if (text === null || text.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON. Fix it and try again.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return parsed;
};

const ensureGitignore = async (root: vscode.Uri): Promise<void> => {
  const uri = vscode.Uri.joinPath(root, GITIGNORE_FILE);
  const next = withGitignoreEntries((await readTextOrNull(uri)) ?? '', GITIGNORE_ENTRIES);
  if (next !== null) {
    await writeText(uri, next);
  }
};

/** Creates an idle state file so the extension activates in this workspace from now on. */
const ensureStateFile = async (root: vscode.Uri): Promise<void> => {
  const uri = vscode.Uri.joinPath(root, BOUNCER_DIR, STATE_FILE);
  if (!(await exists(uri))) {
    const state: BouncerState = { status: 'idle', updatedAt: new Date().toISOString(), sessionId: null };
    await writeJson(uri, state);
  }
};

const currentCommand = (extensionUri: vscode.Uri) => buildHookCommand(hookScriptPath(extensionUri));

/** Removes Bouncer's hooks from the shared settings.json (where older versions put them), if present. */
const removeFromShared = async (uri: vscode.Uri, shared: ClaudeSettings): Promise<boolean> => {
  if (!isBouncerEnabled(shared)) {
    return false;
  }
  await writeJson(uri, removeBouncerHooks(shared));
  return true;
};

export const enableInWorkspace = async (root: vscode.Uri, extensionUri: vscode.Uri): Promise<void> => {
  const files = settingsFiles(root);
  const [local, shared] = await Promise.all([readSettings(files.local), readSettings(files.shared)]);
  await ensureGitignore(root);
  await writeJson(files.local, addBouncerHooks(local, currentCommand(extensionUri)));
  await removeFromShared(files.shared, shared);
  await ensureStateFile(root);
};

/** Removes only Bouncer's handlers, from both settings files. Returns false if it was not enabled. */
export const disableInWorkspace = async (root: vscode.Uri): Promise<boolean> => {
  const files = settingsFiles(root);
  const [local, shared] = await Promise.all([readSettings(files.local), readSettings(files.shared)]);
  const fromShared = await removeFromShared(files.shared, shared);
  if (!isBouncerEnabled(local)) {
    return fromShared;
  }
  await writeJson(files.local, removeBouncerHooks(local));
  return true;
};

/**
 * On activation: if enabled, make sure the hooks match this version (script path after an update, events added
 * in newer versions, hooks moved out of the shared settings.json). Files are rewritten only when something
 * differs. Returns whether Bouncer is enabled.
 */
export const syncHookPath = async (root: vscode.Uri, extensionUri: vscode.Uri): Promise<boolean> => {
  const files = settingsFiles(root);
  let local: ClaudeSettings;
  let shared: ClaudeSettings;
  try {
    [local, shared] = await Promise.all([readSettings(files.local), readSettings(files.shared)]);
  } catch {
    return false;
  }
  if (!isBouncerEnabled(local) && !isBouncerEnabled(shared)) {
    return false;
  }
  const updated = addBouncerHooks(local, currentCommand(extensionUri));
  if (JSON.stringify(updated) !== JSON.stringify(local)) {
    await ensureGitignore(root);
    await writeJson(files.local, updated);
  }
  await removeFromShared(files.shared, shared);
  return true;
};
