# Change Log

All notable changes to Bouncer are documented in this file.

## [0.1.1]

- Works in more editors: now requires VS Code 1.90+ (was 1.125+), so Windsurf, Antigravity, VSCodium and
  older VS Code versions can install it.
- Leftover hooks are now harmless: if Bouncer is uninstalled, Claude no longer shows hook errors.
- The Bouncer avatar now always fits its panel (no more cut-off legs or caption); its panel is now called
  "At the Door".
- Clearer Marketplace listing: new display name, description, tags, screenshots, and README (privacy,
  troubleshooting, uninstalling).

## [0.1.0]

- Hook script that snapshots files before Claude Code edits them and records when Claude finishes.
- Pending Changes view with diff on click, Keep / Undo per file, Keep All / Undo All.
- Status bar count and "Claude finished" notification.
- Enable / Disable commands that manage Bouncer's hooks in `.claude/settings.json`.
- Pixel-art Bouncer avatar with idle, watching, and done states.
