// Extension entry point: wires the snapshot store to the tree, diff provider, status bar, avatar, and commands.
import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { AVATAR_VIEW_ID, CHANGES_VIEW_ID, CONTEXT_KEYS, ORIGINAL_SCHEME } from './constants';
import { syncHookPath } from './setup/hookInstaller';
import { SnapshotStore } from './store/snapshotStore';
import { createFinishedNotifier, createStatusBar } from './ui/statusBar';
import { AvatarViewProvider } from './views/avatarView';
import { ChangesTreeProvider } from './views/changesTree';
import { OriginalContentProvider } from './views/originalContent';

const setContext = (key: string, value: boolean) => vscode.commands.executeCommand('setContext', key, value);

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const store = root ? new SnapshotStore(root) : undefined;

  const tree = new ChangesTreeProvider(() => store?.pending ?? []);
  const avatar = new AvatarViewProvider(context.extensionUri, store);
  context.subscriptions.push(
    tree,
    vscode.window.registerTreeDataProvider(CHANGES_VIEW_ID, tree),
    vscode.window.registerFileDecorationProvider(tree),
    vscode.window.registerWebviewViewProvider(AVATAR_VIEW_ID, avatar),
  );
  registerCommands(context, store);

  if (!store) {
    return;
  }

  const original = new OriginalContentProvider(store);
  context.subscriptions.push(
    store,
    original,
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, original),
    store.onDidChange(() => {
      tree.refresh();
      original.refreshOpen();
      avatar.postState();
      void setContext(CONTEXT_KEYS.hasChanges, store.pending.length > 0);
    }),
  );

  const enabled = await syncHookPath(store.root, context.extensionUri).catch(() => false);
  await setContext(CONTEXT_KEYS.enabled, enabled);
  await store.refresh();

  // Created after the first refresh so the state found at startup doesn't trigger a notification.
  context.subscriptions.push(createStatusBar(store), createFinishedNotifier(store));
}

export function deactivate(): void {}
