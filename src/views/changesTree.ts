// Tree View listing files waiting for review, plus the "N" badge for files Claude created.
import * as vscode from 'vscode';
import { CHANGE_CONTEXT_VALUE, COMMANDS, ITEM_SCHEME } from '../constants';
import type { PendingChange } from '../types';
import { dirName } from '../utils/fs';

const NEW_QUERY = 'new';

/** Tree items use their own scheme so file-icon themes apply but the badge never leaks into the Explorer. */
const itemUri = (change: PendingChange): vscode.Uri =>
  vscode.Uri.from({ scheme: ITEM_SCHEME, path: `/${change.relPath}`, query: change.existed ? '' : NEW_QUERY });

const toTreeItem = (change: PendingChange): vscode.TreeItem => {
  const item = new vscode.TreeItem(itemUri(change));
  item.id = change.id;
  item.description = dirName(change.relPath);
  item.tooltip = change.existed ? change.relPath : `${change.relPath} (new file)`;
  item.contextValue = CHANGE_CONTEXT_VALUE;
  item.command = { command: COMMANDS.openDiff, title: 'Open Diff', arguments: [change] };
  return item;
};

export class ChangesTreeProvider implements vscode.TreeDataProvider<PendingChange>, vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly getChanges: () => readonly PendingChange[]) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(change: PendingChange): vscode.TreeItem {
    return toTreeItem(change);
  }

  getChildren(element?: PendingChange): PendingChange[] {
    return element ? [] : [...this.getChanges()];
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== ITEM_SCHEME || uri.query !== NEW_QUERY) {
      return undefined;
    }
    return new vscode.FileDecoration('N', 'New file', new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
