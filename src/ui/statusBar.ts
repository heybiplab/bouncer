// Status bar count of pending files and the "Claude finished" notification.
import * as vscode from 'vscode';
import { COMMANDS } from '../constants';
import type { SnapshotStore } from '../store/snapshotStore';
import { pluralFiles } from '../utils/format';

const focusView = () => vscode.commands.executeCommand(COMMANDS.focusView);

/** Shows `$(shield) Bouncer: N`, hidden when nothing is waiting. */
export const createStatusBar = (store: SnapshotStore): vscode.Disposable => {
  const item = vscode.window.createStatusBarItem('bouncer.status', vscode.StatusBarAlignment.Left, 100);
  item.name = 'Bouncer';
  item.command = COMMANDS.focusView;

  const update = () => {
    const count = store.pending.length;
    item.text = `$(shield) Bouncer: ${count}`;
    item.tooltip = `${pluralFiles(count)} waiting for review`;
    if (count > 0) {
      item.show();
    } else {
      item.hide();
    }
  };

  update();
  const subscription = store.onDidChange(update);
  return vscode.Disposable.from(item, subscription);
};

/** Notifies once per Stop hook run when files are waiting. Ignores the state found at startup. */
export const createFinishedNotifier = (store: SnapshotStore): vscode.Disposable => {
  let lastSeen = store.currentState?.updatedAt;

  return store.onDidChange(async () => {
    const state = store.currentState;
    if (!state || state.updatedAt === lastSeen) {
      return;
    }
    lastSeen = state.updatedAt;
    const count = store.pending.length;
    if (state.status !== 'done' || count === 0) {
      return;
    }
    const choice = await vscode.window.showInformationMessage(`Bouncer stopped ${pluralFiles(count)} at the door.`, 'Review');
    if (choice === 'Review') {
      await focusView();
    }
  });
};
