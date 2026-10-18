# Bouncer

> Nothing gets into your code without your OK.

Bouncer lets you review every file change Claude Code makes **after it finishes**, instead of approving
each edit one by one. Keep or undo changes per file, or all at once, with a clear red/green diff.

Works in VS Code, Cursor, and other VS Code forks.

> Bouncer is an unofficial, independent tool. It is not made by or affiliated with Anthropic.

## Requirements

- [Claude Code](https://code.claude.com) running in the project folder.
- **Node.js** on your `PATH`. Claude Code runs Bouncer's hook with `node`.
- **git** on your `PATH`, to track changes Claude makes with shell commands.

## Getting started

1. Open your project folder.
2. Click the **Bouncer** icon in the activity bar, then **Enable Bouncer**.
   (Or run **Bouncer: Enable in this workspace** from the Command Palette.)
3. Ask Claude to change some files.
4. When Claude finishes you'll see *"Bouncer stopped 3 files at the door."* Click **Review**.
5. Click a file to see the diff. Use ✓ **Keep** or ↺ **Undo** on each file, or **Keep All** / **Undo All** at the top.

## What you get

- **Pending Changes** list with a badge (`N`) for new files.
- **Diff on click**: the original on the left, Claude's version on the right. New files diff against an empty document.
- **Keep / Undo** per file, plus **Keep All / Undo All**. Undo All always asks first.
- **Status bar** count (`🛡 Bouncer: 3`). Click it to jump to the list.
- **The Bouncer** himself: a tiny pixel-art doorman who watches while Claude works and holds up a sign when files are waiting.

## Commands

| Command | What it does |
|---|---|
| Bouncer: Enable in this workspace | Adds Bouncer's hooks to `.claude/settings.local.json` and keeps Bouncer's files out of git |
| Bouncer: Disable in this workspace | Removes only Bouncer's hooks |
| Bouncer: Open Diff | Pick a pending file and open its diff |
| Bouncer: Keep / Undo | Pick a pending file and keep or undo it |
| Bouncer: Keep All / Undo All | Act on every pending file |

## How it works

- Before Claude edits a file, a `PreToolUse` hook copies the original to `.bouncer/snapshots/`.
  This happens only the first time per file, so you always compare against the pre-session version.
- Changes Claude makes through shell commands (`sed`, scripts, `mv`, `rm`, ...) are tracked too: Bouncer
  compares the project before and after each command and saves the original of every changed, created,
  or deleted file. This uses git internally with a private index, so your staging area is never touched.
- When Claude stops, a `Stop` hook marks the session `done` and Bouncer notifies you.
- **Keep** deletes the snapshot. **Undo** restores the original, or deletes the file if Claude created it.
- The hook never blocks Claude. Errors are written to `.bouncer/hook.log`.

## Good to know

- Bouncer's hooks live in your personal `.claude/settings.local.json`, so teammates are never affected.
  Enable adds that file and `.bouncer/` to `.gitignore`.
- After an extension update, Bouncer updates its hooks automatically the next time it activates.
- In a multi-root workspace, Bouncer uses the first folder.
- Shell-command changes are tracked in git repositories only, and files ignored by `.gitignore` are skipped.
  Each shell command takes about 0.2 s longer while Bouncer compares the project.

## Feedback

Found a bug or have an idea? [Open an issue](https://github.com/heybiplab/bouncer/issues)
or email [dev@heybiplab.in](mailto:dev@heybiplab.in).

## License

[MIT](LICENSE)

## Ideas for later

Per-hunk keep/undo, grouping changes by prompt, change summaries and stats, sensitive-file warnings.
