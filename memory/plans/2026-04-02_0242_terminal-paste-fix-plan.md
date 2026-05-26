# Fix: Terminal detection falsely matches every window

## Context

The terminal paste fix from the last session broke paste for non-terminal apps. The root cause was **`"st"` (suckless terminal) in the terminal name list matching `STRING` in the xprop output prefix `WM_CLASS(STRING) = ...`**, causing every window to be detected as a terminal.

This meant Ctrl+Shift+V was sent everywhere — appearing to work in Chrome (plain-text paste) and terminals, but breaking VS Code (toggles Markdown preview), LibreOffice (Paste Special dialog), and other apps.

## Changes already applied (lib.rs)

Two fixes in `write_text` on Linux:

1. **Replaced enigo with xdotool** for key simulation — uses `--clearmodifiers` to prevent modifier interference, and `windowactivate --sync` to refocus the target window before pasting

2. **Fixed terminal detection parsing** — now extracts only the values after `=` in xprop output (not the `WM_CLASS(STRING)` prefix), and uses exact quoted matching for short names like `"st"` to avoid substring false positives

3. **Added debug logging** — logs target window ID, is_terminal, and paste_key to `whispering.log`

## Verification (dev build running now)

Test push-to-talk paste in:
1. GNOME Terminal → should use ctrl+shift+v
2. Chrome → should use ctrl+v
3. VS Code → should use ctrl+v (NOT toggle markdown preview)
4. LibreOffice Writer → should use ctrl+v (NOT Paste Special)

## After verification

- Build release `.deb` and install
- Commit and update PR #1575
