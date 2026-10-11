// Virtual documents for the left side of the diff: the snapshot, or empty for new files.
import * as vscode from 'vscode';
import { EMPTY_QUERY, ORIGINAL_SCHEME } from '../constants';
import type { SnapshotStore } from '../store/snapshotStore';
import type { PendingChange } from '../types';
import { decodeText } from '../utils/fs';

/** URI of a change's original content; the path keeps the file name so language detection works. */
export const originalUri = (change: PendingChange): vscode.Uri =>
  vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: `/${change.relPath}`, query: change.existed ? change.id : EMPTY_QUERY });

/** URI of an empty document (used when the current file no longer exists). */
export const emptyUri = (relPath: string): vscode.Uri =>
  vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: `/${relPath}`, query: EMPTY_QUERY });

export class OriginalContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly store: SnapshotStore) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const change = uri.query === EMPTY_QUERY ? undefined : this.store.findById(uri.query);
    return change ? decodeText(await this.store.readOriginal(change)) : '';
  }

  /** Tells VS Code to re-read any open original documents (e.g. after a new snapshot). */
  refreshOpen(): void {
    vscode.workspace.textDocuments
      .filter((doc) => doc.uri.scheme === ORIGINAL_SCHEME)
      .forEach((doc) => this.emitter.fire(doc.uri));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
