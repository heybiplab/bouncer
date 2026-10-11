// Webview View showing the pixel-art Bouncer, driven by session state and the pending count.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { AVATAR_MEDIA_DIR } from '../constants';
import type { SnapshotStore } from '../store/snapshotStore';
import type { AvatarMessage } from '../types';
import { readText } from '../utils/fs';

const fillTemplate = (template: string, values: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);

export class AvatarViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: SnapshotStore | undefined,
  ) {}

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    const mediaUri = vscode.Uri.joinPath(this.extensionUri, ...AVATAR_MEDIA_DIR);
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaUri] };
    view.webview.onDidReceiveMessage(() => this.postState());
    view.onDidChangeVisibility(() => this.postState());
    view.onDidDispose(() => {
      this.view = undefined;
    });

    const template = await readText(vscode.Uri.joinPath(mediaUri, 'avatar.html'));
    view.webview.html = fillTemplate(template, {
      cspSource: view.webview.cspSource,
      nonce: randomBytes(16).toString('base64'),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'avatar.css')).toString(),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'avatar.js')).toString(),
    });
  }

  /** Sends the current state; the webview asks for it once ready, and on every store change. */
  postState(): void {
    const message: AvatarMessage = {
      type: 'state',
      status: this.store?.displayStatus ?? 'idle',
      count: this.store?.pending.length ?? 0,
    };
    void this.view?.webview.postMessage(message);
  }
}
