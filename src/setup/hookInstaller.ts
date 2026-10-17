// Adds, removes, and repairs Bouncer's hook entries in the project's .claude/settings.json.
import * as vscode from 'vscode';
import {
  CLAUDE_DIR,
  CLAUDE_SETTINGS_FILE,
  GITIGNORE_ENTRY,
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

/** Adds `.bouncer/` to .gitignore content unless an equivalent line is present. */
export const withGitignoreEntry = (content: string): string | null => {
  const present = content.split(/\r?\n/).some((line) => /^\/?\.bouncer\/?$/.test(line.trim()));
  if (present) {
    return null;
  }
  const separator = content === '' || content.endsWith('\n') ? '' : '\n';
  return `${content}${separator}${GITIGNORE_ENTRY}\n`;
};

const settingsUri = (root: vscode.Uri) => vscode.Uri.joinPath(root, CLAUDE_DIR, CLAUDE_SETTINGS_FILE);

/** Reads settings; missing file means `{}`. Invalid JSON throws so we never overwrite the user's file. */
const readSettings = async (root: vscode.Uri): Promise<ClaudeSettings> => {
  const text = await readTextOrNull(settingsUri(root));
  if (text === null || text.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${CLAUDE_DIR}/${CLAUDE_SETTINGS_FILE} is not valid JSON. Fix it and try again.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${CLAUDE_DIR}/${CLAUDE_SETTINGS_FILE} must contain a JSON object.`);
  }
  return parsed;
};

const ensureGitignore = async (root: vscode.Uri): Promise<void> => {
  const uri = vscode.Uri.joinPath(root, GITIGNORE_FILE);
  const next = withGitignoreEntry((await readTextOrNull(uri)) ?? '');
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

export const enableInWorkspace = async (root: vscode.Uri, extensionUri: vscode.Uri): Promise<void> => {
  const settings = await readSettings(root);
  await writeJson(settingsUri(root), addBouncerHooks(settings, buildHookCommand(hookScriptPath(extensionUri))));
  await ensureGitignore(root);
  await ensureStateFile(root);
};

/** Removes only Bouncer's handlers. Returns false if it was not enabled. */
export const disableInWorkspace = async (root: vscode.Uri): Promise<boolean> => {
  const settings = await readSettings(root);
  if (!isBouncerEnabled(settings)) {
    return false;
  }
  await writeJson(settingsUri(root), removeBouncerHooks(settings));
  return true;
};

/**
 * On activation: if enabled, make sure the hooks match this version (script path after an update, new events
 * added in newer versions). Rewrites the file only when something differs. Returns whether enabled.
 */
export const syncHookPath = async (root: vscode.Uri, extensionUri: vscode.Uri): Promise<boolean> => {
  let settings: ClaudeSettings;
  try {
    settings = await readSettings(root);
  } catch {
    return false;
  }
  if (!isBouncerEnabled(settings)) {
    return false;
  }
  const updated = addBouncerHooks(settings, buildHookCommand(hookScriptPath(extensionUri)));
  if (JSON.stringify(updated) !== JSON.stringify(settings)) {
    await writeJson(settingsUri(root), updated);
  }
  return true;
};
