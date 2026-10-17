// Virtual documents for the left side of the diff: the snapshot, or empty for new files.
import * as vscode from 'vscode';
import { EMPTY_QUERY, ORIGINAL_SCHEME } from '../constants';
import type { SnapshotStore } from '../store/snapshotStore';
import type { PendingChange } from '../types';
import { decodeText } from '../utils/fs';

const VERSION_SEPARATOR = '~';

/**
 * URI of a change's original content. The path keeps the file name so language detection works, and the
 * query includes the snapshot's creation time: a re-created snapshot gets a new URI, so VS Code's
 * document cache can never show a stale original (no change events needed).
 */
export const originalUri = (change: PendingChange): vscode.Uri =>
  vscode.Uri.from({
    scheme: ORIGINAL_SCHEME,
    path: `/${change.relPath}`,
    query: change.existed ? `${change.id}${VERSION_SEPARATOR}${change.createdAt}` : EMPTY_QUERY,
  });

/** URI of an empty document (used when the current file no longer exists). */
export const emptyUri = (relPath: string): vscode.Uri =>
  vscode.Uri.from({ scheme: ORIGINAL_SCHEME, path: `/${relPath}`, query: EMPTY_QUERY });

export class OriginalContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly store: SnapshotStore) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const id = uri.query.split(VERSION_SEPARATOR)[0];
    const change = uri.query === EMPTY_QUERY ? undefined : this.store.findById(id);
    return change ? decodeText(await this.store.readOriginal(change)) : '';
  }
}
