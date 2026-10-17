// Webview View showing the pixel-art Bouncer, driven by session state and the pending count.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { AVATAR_FILES, AVATAR_MEDIA_DIR } from '../constants';
import type { SnapshotStore } from '../store/snapshotStore';
import type { AvatarMessage } from '../types';
import { readText } from '../utils/fs';

const fillTemplate = (template: string, values: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);

export class AvatarViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private template: Promise<string> | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: SnapshotStore | undefined,
  ) {}

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    const mediaUri = vscode.Uri.joinPath(this.extensionUri, ...AVATAR_MEDIA_DIR);
    const asset = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, name)).toString();
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaUri] };

    // The webview reports "ready" each time its page (re)loads; reply with the current state.
    const listeners = [
      view.webview.onDidReceiveMessage(() => this.postState()),
      view.onDidChangeVisibility(() => this.postState()),
    ];
    view.onDidDispose(() => {
      listeners.forEach((l) => l.dispose());
      this.view = undefined;
    });

    // Read the template once per session; it never changes at runtime.
    this.template ??= readText(vscode.Uri.joinPath(mediaUri, AVATAR_FILES.html));
    view.webview.html = fillTemplate(await this.template, {
      cspSource: view.webview.cspSource,
      nonce: randomBytes(16).toString('base64'),
      styleUri: asset(AVATAR_FILES.css),
      scriptUri: asset(AVATAR_FILES.js),
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
