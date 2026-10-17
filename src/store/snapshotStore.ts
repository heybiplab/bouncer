// Reads pending snapshots and session state from .bouncer/, and performs Keep / Undo on them.
import * as vscode from 'vscode';
import { BOUNCER_DIR, META_EXT, REFRESH_DEBOUNCE_MS, SNAP_EXT, SNAPSHOTS_DIR, STATE_FILE, WATCH_GLOB } from '../constants';
import type { BouncerState, BouncerStatus, PendingChange, SnapshotMeta } from '../types';
import { deleteIfExists, exists, readBytes, readJson, writeBytes } from '../utils/fs';

const isSnapshotMeta = (value: unknown): value is SnapshotMeta => {
  const meta = value as Partial<SnapshotMeta> | null;
  return typeof meta?.path === 'string' && typeof meta.existed === 'boolean';
};

const isBouncerState = (value: unknown): value is BouncerState => {
  const status = (value as Partial<BouncerState> | null)?.status;
  return status === 'idle' || status === 'watching' || status === 'done';
};

/** Resolves a workspace-relative POSIX path under the root, rejecting anything that escapes it. */
const resolveInside = (root: vscode.Uri, relPath: string): vscode.Uri | null => {
  const segments = relPath.split('/');
  return segments.some((s) => s === '..' || s === '') ? null : vscode.Uri.joinPath(root, ...segments);
};

export class SnapshotStore implements vscode.Disposable {
  private changes: PendingChange[] = [];
  private state: BouncerState | null = null;
  private generation = 0;
  private signature: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly watcher: vscode.FileSystemWatcher;

  /** Fires after every refresh (pending list or state may have changed). */
  readonly onDidChange = this.emitter.event;

  constructor(readonly root: vscode.Uri) {
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, WATCH_GLOB));
    const schedule = () => this.scheduleRefresh();
    this.watcher.onDidCreate(schedule);
    this.watcher.onDidChange(schedule);
    this.watcher.onDidDelete(schedule);
  }

  get pending(): readonly PendingChange[] {
    return this.changes;
  }

  get currentState(): BouncerState | null {
    return this.state;
  }

  /** Status as the UI should show it: a finished session with nothing left to review is idle. */
  get displayStatus(): BouncerStatus {
    const status = this.state?.status ?? 'idle';
    return status === 'done' && this.changes.length === 0 ? 'idle' : status;
  }

  get bouncerDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.root, BOUNCER_DIR);
  }

  private get snapshotsDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.bouncerDir, SNAPSHOTS_DIR);
  }

  get stateUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.bouncerDir, STATE_FILE);
  }

  findById(id: string): PendingChange | undefined {
    return this.changes.find((c) => c.id === id);
  }

  /** Reloads pending changes and state from disk, then notifies listeners. */
  async refresh(): Promise<void> {
    const gen = ++this.generation;
    const [changes, state] = await Promise.all([this.loadChanges(), readJson<unknown>(this.stateUri)]);
    if (gen !== this.generation) {
      return;
    }
    const nextState = isBouncerState(state) ? state : null;
    // Watcher events also fire for our own writes; only notify listeners when something visible changed.
    const signature = JSON.stringify([changes.map((c) => [c.id, c.createdAt, c.existed]), nextState]);
    if (signature === this.signature) {
      return;
    }
    this.signature = signature;
    this.changes = changes;
    this.state = nextState;
    this.emitter.fire();
  }

  /** Runs mutations one at a time, so double clicks or overlapping bulk actions can't race. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** True if the snapshot still exists on disk (it may have been handled moments ago). */
  private isStillPending(change: PendingChange): Promise<boolean> {
    return exists(change.metaUri);
  }

  /** Original bytes of a file (empty for files Claude created). */
  async readOriginal(change: PendingChange): Promise<Uint8Array> {
    return change.existed ? readBytes(change.snapUri) : new Uint8Array();
  }

  /** Keep: accept Claude's version by forgetting the snapshot. */
  keep(change: PendingChange): Promise<void> {
    return this.serialize(async () => {
      await this.forget(change);
      await this.refresh();
    });
  }

  /** Undo: restore the original content, or delete the file if Claude created it. */
  undo(change: PendingChange): Promise<void> {
    return this.serialize(async () => {
      if (await this.isStillPending(change)) {
        await this.restore(change);
        await this.forget(change);
      }
      await this.refresh();
    });
  }

  keepAll(): Promise<void> {
    return this.serialize(async () => {
      await Promise.all(this.changes.map((c) => this.forget(c)));
      await this.refresh();
    });
  }

  /** Undoes every pending change; returns the paths that failed. */
  undoAll(): Promise<string[]> {
    return this.serialize(async () => {
      const targets = [...this.changes];
      const results = await Promise.allSettled(
        targets.map(async (c) => {
          await this.restore(c);
          await this.forget(c);
        }),
      );
      await this.refresh();
      return results.flatMap((r, i) => (r.status === 'rejected' ? [targets[i].relPath] : []));
    });
  }

  private async restore(change: PendingChange): Promise<void> {
    if (!change.existed) {
      await deleteIfExists(change.fileUri);
      return;
    }
    let original: Uint8Array;
    try {
      original = await readBytes(change.snapUri);
    } catch {
      throw new Error(`The saved original of ${change.relPath} is missing, so it can't be restored.`);
    }
    await writeBytes(change.fileUri, original);
  }

  /** Deletes the meta first (the commit marker), then the content copy. */
  private async forget(change: PendingChange): Promise<void> {
    await deleteIfExists(change.metaUri);
    await deleteIfExists(change.snapUri);
  }

  private async loadChanges(): Promise<PendingChange[]> {
    // Check first: the folder is absent until the first snapshot, and a failed readDirectory gets logged as an error.
    if (!(await exists(this.snapshotsDir))) {
      return [];
    }
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.snapshotsDir);
    } catch {
      return [];
    }
    const metaNames = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(META_EXT))
      .map(([name]) => name);
    const changes = await Promise.all(metaNames.map((name) => this.loadChange(name)));
    return changes.filter((c): c is PendingChange => c !== null).sort((a, b) => a.relPath.localeCompare(b.relPath));
  }

  private async loadChange(metaName: string): Promise<PendingChange | null> {
    const id = metaName.slice(0, -META_EXT.length);
    const metaUri = vscode.Uri.joinPath(this.snapshotsDir, metaName);
    const meta = await readJson<unknown>(metaUri);
    const fileUri = isSnapshotMeta(meta) ? resolveInside(this.root, meta.path) : null;
    if (!isSnapshotMeta(meta) || !fileUri) {
      return null;
    }
    return {
      id,
      relPath: meta.path,
      existed: meta.existed,
      createdAt: meta.createdAt,
      fileUri,
      metaUri,
      snapUri: vscode.Uri.joinPath(this.snapshotsDir, `${id}${SNAP_EXT}`),
    };
  }

  private scheduleRefresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), REFRESH_DEBOUNCE_MS);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher.dispose();
    this.emitter.dispose();
  }
}
