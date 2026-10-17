// Registers every Bouncer command: diff, keep/undo (single and bulk), and enable/disable.
import * as vscode from 'vscode';
import { COMMANDS, CONTEXT_KEYS, ORIGINAL_SCHEME, STATUS_MESSAGE_MS } from '../constants';
import { disableInWorkspace, enableInWorkspace } from '../setup/hookInstaller';
import type { SnapshotStore } from '../store/snapshotStore';
import type { PendingChange } from '../types';
import { baseName, dirName, exists, isBinary, readBytes } from '../utils/fs';
import { pluralFiles } from '../utils/format';
import { emptyUri, originalUri } from '../views/originalContent';

const ALL_CLEAR = "All clear. Nobody's waiting at the door.";

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Wraps a command so failures show a friendly error instead of disappearing. */
const safely =
  <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
  async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      void vscode.window.showErrorMessage(`Bouncer: ${errorMessage(err)}`);
    }
  };

const flash = (text: string) => vscode.window.setStatusBarMessage(text, STATUS_MESSAGE_MS);

const isPendingChange = (value: unknown): value is PendingChange =>
  typeof (value as Partial<PendingChange> | undefined)?.id === 'string';

/** Uses the tree item passed in, or asks the user to pick one (Command Palette). */
const resolveChange = async (store: SnapshotStore, arg: unknown, placeHolder: string): Promise<PendingChange | undefined> => {
  if (isPendingChange(arg)) {
    // A tree item can be stale (e.g. clicked twice, or handled from another window): only act on live changes.
    const live = store.findById(arg.id);
    if (!live) {
      flash(`$(info) Bouncer: ${baseName(arg.relPath)} was already handled`);
    }
    return live;
  }
  if (store.pending.length === 0) {
    void vscode.window.showInformationMessage(ALL_CLEAR);
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    store.pending.map((change) => ({
      label: baseName(change.relPath),
      description: [dirName(change.relPath), change.existed ? '' : 'new'].filter(Boolean).join(' · '),
      change,
    })),
    { placeHolder },
  );
  return picked?.change;
};

const isDirty = (change: PendingChange): boolean =>
  vscode.workspace.textDocuments.some((doc) => doc.isDirty && doc.uri.toString() === change.fileUri.toString());

/** Closes diff tabs Bouncer opened for these changes. */
const closeDiffTabs = async (changes: readonly PendingChange[]): Promise<void> => {
  const paths = new Set(changes.map((c) => `/${c.relPath}`));
  const tabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      ({ input }) =>
        input instanceof vscode.TabInputTextDiff &&
        input.original.scheme === ORIGINAL_SCHEME &&
        paths.has(input.original.path),
    );
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs);
  }
};

const openDiff = async (store: SnapshotStore, arg: unknown): Promise<void> => {
  const change = await resolveChange(store, arg, 'Which file do you want to review?');
  if (!change) {
    return;
  }
  const currentExists = await exists(change.fileUri);
  const original = await store.readOriginal(change);
  const current = currentExists ? await readBytes(change.fileUri) : new Uint8Array();
  if (isBinary(original) || isBinary(current)) {
    void vscode.window.showInformationMessage(`${change.relPath} is a binary file, so there's no text diff to show.`);
    if (currentExists) {
      await vscode.commands.executeCommand('vscode.open', change.fileUri);
    }
    return;
  }
  const name = baseName(change.relPath);
  const title = change.existed ? `${name} (Original ↔ Claude)` : `${name} (New file)`;
  const right = currentExists ? change.fileUri : emptyUri(change.relPath);
  await vscode.commands.executeCommand('vscode.diff', originalUri(change), right, title, { preview: true });
};

const keep = async (store: SnapshotStore, arg: unknown): Promise<void> => {
  const change = await resolveChange(store, arg, 'Which file do you want to keep?');
  if (!change) {
    return;
  }
  await store.keep(change);
  await closeDiffTabs([change]);
  flash(`$(check) Bouncer: kept ${baseName(change.relPath)}`);
};

const undo = async (store: SnapshotStore, arg: unknown): Promise<void> => {
  const change = await resolveChange(store, arg, 'Which file do you want to undo?');
  if (!change) {
    return;
  }
  if (isDirty(change)) {
    const answer = await vscode.window.showWarningMessage(
      `${baseName(change.relPath)} has unsaved changes. Undo will restore the original file on disk.`,
      { modal: true },
      'Undo Anyway',
    );
    if (answer !== 'Undo Anyway') {
      return;
    }
  }
  await store.undo(change);
  await closeDiffTabs([change]);
  flash(`$(discard) Bouncer: undid ${baseName(change.relPath)}`);
};

const keepAll = async (store: SnapshotStore): Promise<void> => {
  const changes = [...store.pending];
  if (changes.length === 0) {
    void vscode.window.showInformationMessage(ALL_CLEAR);
    return;
  }
  await store.keepAll();
  await closeDiffTabs(changes);
  flash(`$(check) Bouncer: kept ${pluralFiles(changes.length)}`);
};

const undoAll = async (store: SnapshotStore): Promise<void> => {
  const changes = [...store.pending];
  if (changes.length === 0) {
    void vscode.window.showInformationMessage(ALL_CLEAR);
    return;
  }
  const dirtyCount = changes.filter(isDirty).length;
  const dirtyNote = dirtyCount > 0 ? ` ${pluralFiles(dirtyCount)} also ha${dirtyCount === 1 ? 's' : 've'} unsaved changes.` : '';
  const answer = await vscode.window.showWarningMessage(
    `Undo all changes to ${pluralFiles(changes.length)}?`,
    { modal: true, detail: `Originals will be restored and new files deleted. This can't be undone.${dirtyNote}` },
    'Undo All',
  );
  if (answer !== 'Undo All') {
    return;
  }
  const failed = await store.undoAll();
  await closeDiffTabs(changes);
  if (failed.length > 0) {
    void vscode.window.showErrorMessage(`Bouncer couldn't undo: ${failed.join(', ')}`);
  } else {
    flash(`$(discard) Bouncer: undid ${pluralFiles(changes.length)}`);
  }
};

const setEnabled = (enabled: boolean) => vscode.commands.executeCommand('setContext', CONTEXT_KEYS.enabled, enabled);

const enable = async (store: SnapshotStore, extensionUri: vscode.Uri): Promise<void> => {
  await enableInWorkspace(store.root, extensionUri);
  await setEnabled(true);
  await store.refresh();
  void vscode.window.showInformationMessage(
    "Bouncer is on the door. Claude's edits in this workspace will wait here for your review.",
  );
};

const disable = async (store: SnapshotStore): Promise<void> => {
  const wasEnabled = await disableInWorkspace(store.root);
  await setEnabled(false);
  void vscode.window.showInformationMessage(
    wasEnabled ? 'Bouncer is off duty in this workspace.' : "Bouncer wasn't enabled in this workspace.",
  );
};

const noWorkspace = async (): Promise<void> => {
  void vscode.window.showWarningMessage('Bouncer needs an open folder. Open a project folder first.');
};

export const registerCommands = (context: vscode.ExtensionContext, store: SnapshotStore | undefined): void => {
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = store
    ? {
        [COMMANDS.openDiff]: (arg) => openDiff(store, arg),
        [COMMANDS.keep]: (arg) => keep(store, arg),
        [COMMANDS.undo]: (arg) => undo(store, arg),
        [COMMANDS.keepAll]: () => keepAll(store),
        [COMMANDS.undoAll]: () => undoAll(store),
        [COMMANDS.enable]: () => enable(store, context.extensionUri),
        [COMMANDS.disable]: () => disable(store),
      }
    : Object.fromEntries(Object.values(COMMANDS).filter((id) => id !== COMMANDS.focusView).map((id) => [id, noWorkspace]));

  for (const [id, handler] of Object.entries(handlers)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, safely(handler)));
  }
};
