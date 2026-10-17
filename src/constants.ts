// Shared identifiers and folder names used across the extension (no magic strings elsewhere).

export const BOUNCER_DIR = '.bouncer';
export const SNAPSHOTS_DIR = 'snapshots';
export const STATE_FILE = 'state.json';
export const META_EXT = '.json';
export const SNAP_EXT = '.snap';

export const CLAUDE_DIR = '.claude';
export const CLAUDE_SETTINGS_FILE = 'settings.json';
export const GITIGNORE_FILE = '.gitignore';
export const GITIGNORE_ENTRY = '.bouncer/';

export const HOOK_SCRIPT_DIR = 'hooks';
export const HOOK_SCRIPT_FILE = 'bouncer-hook.mjs';
export const HOOK_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash';
export const SHELL_MATCHER = 'Bash';
export const HOOK_TIMEOUT_SECONDS = 10;

export const ORIGINAL_SCHEME = 'bouncer-original';
export const ITEM_SCHEME = 'bouncer-item';
export const EMPTY_QUERY = 'empty';

export const VIEW_CONTAINER_ID = 'bouncer';
export const CHANGES_VIEW_ID = 'bouncer.changes';
export const AVATAR_VIEW_ID = 'bouncer.avatar';
export const CHANGE_CONTEXT_VALUE = 'bouncer.change';

export const COMMANDS = {
  openDiff: 'bouncer.openDiff',
  keep: 'bouncer.keep',
  undo: 'bouncer.undo',
  keepAll: 'bouncer.keepAll',
  undoAll: 'bouncer.undoAll',
  enable: 'bouncer.enable',
  disable: 'bouncer.disable',
  focusView: `${CHANGES_VIEW_ID}.focus`,
} as const;

export const CONTEXT_KEYS = {
  enabled: 'bouncer.enabled',
  hasChanges: 'bouncer.hasChanges',
} as const;

/**
 * Files the extension reacts to: the state file and snapshot records (the .json is written last, after its
 * .snap, so it alone signals a finished snapshot). The folders are included so deleting them is noticed.
 * Raw .snap copies, temp files, and hook.log are ignored.
 */
export const WATCH_GLOB = `{${BOUNCER_DIR},${BOUNCER_DIR}/${STATE_FILE},${BOUNCER_DIR}/${SNAPSHOTS_DIR},${BOUNCER_DIR}/${SNAPSHOTS_DIR}/*${META_EXT}}`;

export const REFRESH_DEBOUNCE_MS = 100;
export const STATUS_MESSAGE_MS = 3000;
export const BINARY_SNIFF_BYTES = 8000;

export const AVATAR_MEDIA_DIR = ['media', 'avatar'] as const;
export const AVATAR_FILES = { html: 'avatar.html', css: 'avatar.css', js: 'avatar.js' } as const;
