# Active Context

## Current Focus
Whispering desktop app — debugging and fixing Linux paste issues. Need to start fresh from upstream and apply a clean, minimal terminal fix.

## Recent Changes
- [2026-04-02] Discovered the "st" matching bug: `"st"` (suckless terminal) in the terminal list was matching `STRING` in xprop output prefix `WM_CLASS(STRING) = ...`, causing EVERY window to be detected as terminal → Ctrl+Shift+V sent everywhere
- [2026-04-02] Replaced enigo with xdotool for Linux paste (more reliable with `--clearmodifiers`)
- [2026-04-02] Added Escape key workaround and increased clipboard restore delay — these were unnecessary, caused by Alt+D shortcut activating VS Code menu bar
- [2026-04-02] Pushed changes to `fix/terminal-paste-and-http-plugin` branch but plan to start fresh

## Next Steps
- [ ] Reset fork to upstream/main (clean slate)
- [ ] Apply ONLY the terminal detection fix (minimal change)
- [ ] Test thoroughly in terminal, VS Code, Chrome, text editor, LibreOffice before adding more changes
- [ ] Keep changes minimal to avoid merge conflicts with upstream

## Blockers / Open Questions
- Alt-based shortcuts (e.g. Alt+D) activate menu bars in apps like VS Code — this is expected OS behavior, NOT a bug in our code. User should use non-Alt shortcuts for push-to-talk if using VS Code.
- The "2.0.0 update" notification in Whispering was a false alarm — upstream latest is still v7.11.0

## Session Notes
- User prefers minimal changes to avoid merge conflicts with upstream
- Ghost-chasing: spent time debugging paste issues that were actually caused by the `"st"` matching bug and the Alt+D shortcut, not by enigo, timing, or focus issues
