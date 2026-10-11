# Bouncer — VS Code extension

> "Nothing gets into your code without your OK."

Bouncer lets developers review every file change made by Claude Code **after Claude finishes**,
instead of approving each edit one by one. Users can keep or undo changes per file, or all at once,
with clear green/red highlighting of what changed.

Bouncer is an **unofficial, independent** tool. It is not made by or affiliated with Anthropic.
Never use Anthropic's name or logo in the extension name, icon, or branding.

Target editors: VS Code, Cursor, and other VS Code forks (e.g. Antigravity).

---

## How it works

1. **Hook (before each edit):** a Claude Code `PreToolUse` hook runs `hooks/bouncer-hook.mjs`
   before Claude edits or creates a file. It saves the file's original content to
   `.bouncer/snapshots/` (only the first time per file, so the snapshot is always the
   pre-session version). If the file did not exist, it records that, so Undo can delete it.
2. **Hook (Claude finished):** a `Stop` hook updates `.bouncer/state.json` to `done`.
3. **Extension:** watches `.bouncer/` and shows all pending files in the Bouncer sidebar.
4. **Review:** clicking a file opens a diff (original vs current) with green for added
   lines and red for removed lines.
5. **Decide:** Keep = delete the snapshot. Undo = restore the original (or delete the file if it was new).

Before writing any hook code, read the official Claude Code hooks documentation and use the
current input format, event names, and tool names exactly as documented:
https://code.claude.com/docs/en/hooks

---

## v1 scope (build exactly this, nothing more)

### Core review (required)

- **Pending changes list** in a Bouncer sidebar Tree View: file name, relative path,
  and a badge for `new` files.
- **Click a file** → open a diff editor (snapshot on the left, current file on the right).
  New files diff against an empty virtual document.
- **Per-file actions** as inline buttons on each tree item: `Keep` and `Undo`.
- **Bulk actions** in the view title bar: `Keep All` and `Undo All`.
  `Undo All` must ask for confirmation (modal) because it is destructive.
- **Status bar item:** shows the pending count (e.g. `$(shield) Bouncer: 3`); clicking it
  focuses the Bouncer view. Hidden when there is nothing to review.
- **"Claude finished" notification:** when the Stop hook fires and there are pending files,
  show: `Bouncer stopped 3 files at the door.` with a `Review` button.

### Setup (required, so other users can use it)

- Command `Bouncer: Enable in this workspace`:
  - Adds the PreToolUse and Stop hooks to the project's `.claude/settings.json`
    (merge with existing settings, never overwrite other entries).
  - Uses the hook script bundled inside the extension (absolute path via `context.extensionPath`).
  - Adds `.bouncer/` to `.gitignore` if not already present.
- On activation, if Bouncer is enabled but the stored hook path is outdated
  (e.g. after an extension update), update the path silently.
- Command `Bouncer: Disable in this workspace` removes only Bouncer's hook entries.

### Bouncer avatar (required, keep it lightweight)

Note: third-party extensions **cannot** draw inside the Claude Code chat panel or its input box.
The avatar lives in Bouncer's own sidebar instead, as a small Webview View above the file list.

- A tiny pixel-art Bouncer character (inline SVG or CSS pixel art, no image libraries).
- Three states driven by `.bouncer/state.json`:
  - `idle`: standing at the door, occasional blink.
  - `watching`: Claude is editing; Bouncer paces or checks a clipboard; shows the live count.
  - `done`: Bouncer holds up a sign: "3 waiting at the door".
- Pure CSS animations (`steps()` keyframes). Respect `prefers-reduced-motion`.
- Must follow the editor theme using VS Code CSS variables (`--vscode-*`).

### Explicitly out of scope for v1

Per-hunk keep/undo, grouping by prompt, change summaries, stats, sensitive-file warnings,
files deleted via shell commands. Do not build these. Mention them only as future ideas.

---

## Tech stack

- **Language:** TypeScript (`strict: true`), modern ES2022+ syntax.
- **Runtime:** Node.js, VS Code Extension API only. **No web frameworks** (no Express, NestJS, React).
- **Bundler:** esbuild (single bundled output for fast activation).
- **Dependencies:** keep to zero if possible. Only add a package if it clearly saves work and is small.
- **Hook script:** plain Node.js ESM (`.mjs`), **zero dependencies**, synchronous `fs`, must finish fast.
- **Versions:** use the latest stable versions of all dev dependencies at install time
  (check with `npm view <pkg> version`; do not rely on memorised versions).
  **Exception:** `engines.vscode` and `@types/vscode` must match the oldest VS Code version
  we support. Check which VS Code version the current Cursor release is based on and set
  `engines.vscode` to that, so the extension installs in Cursor too.

---

## Code style

- ES modules (`import`/`export`), `const`/`let`, arrow functions, async/await,
  optional chaining, nullish coalescing, destructuring, template literals.
- Small, single-purpose functions. Prefer pure functions for logic.
- No `any`. Define shared types in `src/types.ts`.
- No duplicated logic: shared helpers go in `src/utils/`.
- Every file starts with a one-line comment explaining its role.
- Everything the extension creates (watchers, commands, views, status bar) must be added
  to `context.subscriptions` so it is disposed correctly.
- Constants (folder names, command IDs, view IDs) live in `src/constants.ts`. No magic strings.

---

## File structure

```
bouncer/
├── CLAUDE.md
├── package.json              # manifest: commands, views, menus, activation
├── tsconfig.json
├── esbuild.mjs               # build script
├── hooks/
│   └── bouncer-hook.mjs      # PreToolUse + Stop hook (zero dependencies)
├── media/
│   ├── icon.png              # marketplace icon (original artwork)
│   └── avatar/               # avatar webview HTML/CSS
└── src/
    ├── extension.ts          # activate/deactivate: wires everything together
    ├── constants.ts
    ├── types.ts
    ├── store/
    │   └── snapshotStore.ts  # list, read, keep, undo snapshots
    ├── views/
    │   ├── changesTree.ts    # Tree View of pending files
    │   └── avatarView.ts     # Bouncer avatar Webview View
    ├── commands/
    │   └── index.ts          # registers all commands
    ├── setup/
    │   └── hookInstaller.ts  # enable/disable hooks in .claude/settings.json
    ├── ui/
    │   └── statusBar.ts
    └── utils/
        └── fs.ts             # small fs helpers (workspace.fs based)
```

Snapshot storage format (one pair of files per snapshot, no shared manifest, to avoid
race conditions when hooks run in parallel):

- `.bouncer/snapshots/<id>.snap` — original file content
- `.bouncer/snapshots/<id>.json` — `{ "path": "<workspace-relative>", "existed": true, "createdAt": "<ISO>" }`

---

## Reliability rules (important)

- **The hook must never block or break Claude.** Wrap everything in try/catch and always
  exit with code 0. On error, write a line to `.bouncer/hook.log` and exit quietly.
- Never snapshot files outside the workspace, or inside `.bouncer/`, `.git/`, or `node_modules/`.
- Handle binary files safely (copy bytes, do not decode as text).
- Before Undo, if the file has unsaved changes in an open editor, warn the user first.
- Undo / Keep must update the tree, status bar, and avatar immediately.
- Activation must be lazy and fast: activate on the Bouncer view or when `.bouncer/` exists,
  not on every startup.

---

## UI / UX rules

- Use VS Code codicons (`$(check)`, `$(discard)`, `$(shield)`) for a native look.
- Clear, friendly copy in Bouncer's voice, but short. Example empty state:
  "All clear. Nobody's waiting at the door."
- Keyboard-friendly: all actions available from the Command Palette, prefixed `Bouncer:`.
- Destructive actions (Undo All) always confirm. Single Undo does not, but shows a short
  status message.

---

## Workflow with me

- Build **one milestone at a time** and stop after each one.
- After each milestone: list changed files, explain briefly how it works, and give me
  step-by-step manual test instructions (using F5 / Extension Development Host).
- Do not start the next milestone until I confirm.
- If something in the docs differs from this file, follow the docs and tell me.

### Milestones

1. Hook script: snapshots + state file, tested standalone with sample JSON input.
2. Snapshot store + Tree View listing pending files.
3. Diff on click (including new files).
4. Keep / Undo / Keep All / Undo All.
5. Status bar + "Claude finished" notification.
6. Enable / Disable setup commands.
7. Bouncer avatar webview.
8. Final pass: README, error handling review, package with `vsce` and test install in VS Code and Cursor.
