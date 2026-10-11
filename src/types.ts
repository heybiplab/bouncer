// Shared types for snapshots, session state, avatar messages, and Claude Code settings.
import type * as vscode from 'vscode';

/** Contents of `.bouncer/snapshots/<id>.json`, written by the hook. */
export interface SnapshotMeta {
  path: string;
  existed: boolean;
  createdAt: string;
}

/** One file waiting for review. */
export interface PendingChange {
  id: string;
  relPath: string;
  existed: boolean;
  createdAt: string;
  fileUri: vscode.Uri;
  metaUri: vscode.Uri;
  snapUri: vscode.Uri;
}

export type BouncerStatus = 'idle' | 'watching' | 'done';

/** Contents of `.bouncer/state.json`. */
export interface BouncerState {
  status: BouncerStatus;
  updatedAt: string;
  sessionId: string | null;
}

/** Message the extension posts to the avatar webview. */
export interface AvatarMessage {
  type: 'state';
  status: BouncerStatus;
  count: number;
}

/** One handler inside a Claude Code hook matcher group. */
export interface HookHandler {
  type: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

/** A matcher group: `{ matcher, hooks: [...] }`. */
export interface HookMatcherGroup {
  matcher?: string;
  hooks: HookHandler[];
  [key: string]: unknown;
}

export type HooksConfig = Record<string, HookMatcherGroup[]>;

/** The subset of `.claude/settings.json` Bouncer reads and writes; other keys are preserved. */
export interface ClaudeSettings {
  hooks?: HooksConfig;
  [key: string]: unknown;
}
