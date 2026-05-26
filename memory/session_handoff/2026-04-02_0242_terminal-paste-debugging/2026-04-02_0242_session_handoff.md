# Epicenter (Whispering) - Session Handoff

**Date**: 2026-04-02
**Location**: `/home/robert/Dev/epicenter`
**Session Goal**: Debug why terminal paste fix from previous session broke paste for non-terminal apps. Identify root cause and determine the minimal fix needed.

---

## Chronological Narrative

### 1. Context Restoration
- **Starting state**: Previous session added terminal detection (xprop WM_CLASS) to `write_text` in lib.rs. Terminal paste (Ctrl+Shift+V) worked, but non-terminal apps stopped pasting.
- **User report**: "now it only works on the terminal but not on other apps"

### 2. Initial Investigation (Speculation Phase — Dead End)
- **Theory 1 — Always-on-top stealing focus**: User had `ui.alwaysOnTop` enabled. Disabling it helped some apps but not all. This was a red herring — the real issue was elsewhere.
- **Theory 2 — Stuck Shift modifier from push-to-talk**: Hypothesized that `Alt+Shift+D` shortcut left Shift stuck. Wrong — user's actual shortcut was `Alt+D` (no Shift).
- **Key mistake**: Speculated instead of adding logging. Multiple theories and code changes were applied without verifying each one.

### 3. Root Cause Found — "st" Matching Bug
- **The Bug**: Added `log::info!` to `write_text`. Logs showed `is_terminal=true` for VS Code (window `77594814`).
- **Verified**: `xprop -id 77594814 WM_CLASS` returns `"code", "Code"` — clearly not a terminal.
- **Root Cause**: The terminal name list included `"st"` (suckless terminal). The detection code checked if the ENTIRE xprop output line contained any terminal name. xprop output format is `WM_CLASS(STRING) = "code", "Code"`. The word `STRING` contains `st`, so `class.contains("st")` returned true for **every window**.
- **This was the only real bug.** Everything else was a consequence of it.

### 4. Changes Applied (Some Necessary, Some Not)
Applied in this order:

1. **Replaced enigo with xdotool for Linux paste** — Uses `xdotool key --clearmodifiers` instead of enigo's `XTestFakeKeyEvent`. More robust but NOT strictly necessary to fix the bug.

2. **Fixed xprop output parsing** — Parse only values after `=`, not the `WM_CLASS(STRING)` prefix. For short names (≤3 chars like "st"), use exact quoted matching: `values.contains("\"st\"")`. **This is the essential fix.**

3. **Added `windowactivate --sync`** — Refocuses target window before paste. Unnecessary for the core bug.

4. **Added Escape key press** — Dismisses menus activated by Alt-based shortcuts. Workaround for user's `Alt+D` shortcut activating VS Code's File menu. Not a code bug.

5. **Increased clipboard restore delay** — From 100ms to 300ms. Was trying to fix VS Code paste, but the real issue was menu activation from Alt+D.

6. **Added debug logging** — `log::info!` in write_text showing target_window, is_terminal, paste_key. Useful for diagnostics.

### 5. VS Code Paste Still Fails
- After fixing the "st" bug, paste worked in Chrome, text editor, and terminal.
- VS Code still failed — but this was because user's `Alt+D` push-to-talk shortcut activates VS Code's menu bar on Alt release, stealing focus from the editor.
- This is standard OS/DE behavior, not a code bug. User needs a non-Alt shortcut for VS Code.

### 6. Decision to Start Fresh
- User recognized too many changes were stacked chasing symptoms.
- **Plan**: Reset fork to upstream/main, apply ONLY the essential terminal detection fix, test everything before adding more.
- Current changes pushed to `fix/terminal-paste-and-http-plugin` branch for reference.

---

## Current Technical State

- **Branch `fix/terminal-paste-and-http-plugin`**: Has all changes from both sessions (HTTP fix, terminal fix, xdotool switch, workarounds). Pushed to `origin`. **Should be discarded in favor of a clean fix.**
- **PR #1575**: Open on EpicenterHQ/epicenter. Contains original terminal fix + HTTP version pin + current session's changes. Needs to be updated with clean fix.
- **Upstream**: No new commits on `upstream/main` since last sync. The "2.0.0 update" notification in the app was a false alarm.
- **Installed `.deb`**: Still the previous session's build (with the "st" bug). Needs rebuild after clean fix.

---

## Files Changed

### Modified
| File | What Changed |
|------|-------------|
| `apps/whispering/src-tauri/src/lib.rs` | Replaced enigo with xdotool on Linux, fixed xprop parsing, added logging, workarounds |
| `memory/active_context.md` | Updated with current state and plan |
| `memory/changelog.md` | Added 2026-04-02 entry |
| `memory/changelog_summary.md` | Updated current state |
| `memory/task_list.md` | Updated progress |
| `memory/learnings/LEARNINGS.md` | Added LRN-004 (xprop parsing), LRN-005 (Alt key menus), LRN-006 (logging before speculating) |
| `memory/learnings/ERRORS.md` | Added ERR-004 ("st" matching "STRING") |

### Created
| File | Purpose |
|------|---------|
| `memory/plans/2026-04-02_0242_terminal-paste-fix-plan.md` | Plan file from this session |

### Key Reference Files
| File | Why It Matters |
|------|---------------|
| `apps/whispering/src-tauri/src/lib.rs:210-355` | `write_text` command — all paste logic lives here |
| `apps/whispering/src/lib/commands.ts` | Command definitions including push-to-talk trigger config |
| `apps/whispering/src/routes/(app)/_layout-utils/alwaysOnTop.svelte.ts` | Reactive always-on-top behavior during recording |
| `apps/whispering/src/lib/query/delivery.ts` | Delivery flow: clipboard + cursor + enter after transcription |

---

## Problems Faced & Solutions

| Problem | Solution |
|---------|----------|
| `is_terminal=true` for every window | `"st"` (suckless terminal) matched `STRING` in xprop prefix. Fix: parse only values after `=`, exact quoted match for short names |
| `xdotool key --window` didn't work | XSendEvent is ignored by most apps. Removed `--window`, use `windowactivate` instead |
| VS Code paste fails with Alt+D shortcut | Alt release activates VS Code menu bar, stealing focus. Not a code bug — use non-Alt shortcuts |
| Speculated too long without data | Added `log::info!` — found root cause in seconds from log output |

---

## Next Session Action Plan

1. **Reset fork to upstream/main** — `git checkout main && git reset --hard upstream/main && git push --force origin main`
2. **Create a new clean branch** — `git checkout -b fix/terminal-paste-v2`
3. **Apply ONLY the essential terminal detection fix** — The minimal change to `lib.rs`:
   - Keep using enigo (original upstream approach)
   - Just fix the xprop parsing: extract values after `=`, exact quoted match for short names
   - Keep the `#[cfg(target_os = "linux")]` structure from upstream
4. **Test thoroughly** — Terminal, VS Code (with non-Alt shortcut), Chrome, text editor, LibreOffice
5. **Build `.deb`** — Only after all tests pass
6. **Update PR #1575** — With the clean, minimal fix

### The Minimal Fix (Apply This)

The ONLY change needed to upstream's terminal detection in `lib.rs` `write_text`:

```rust
// BEFORE (upstream, buggy):
.map(|class| {
    let class = class.trim().to_lowercase();
    ["gnome-terminal", ..., "st", ...]
    .iter()
    .any(|t| class.contains(t))
        || class.contains("terminal")
        || class.contains("term")
})

// AFTER (fixed):
.map(|raw| {
    // Extract only values after "=" to avoid matching "STRING" prefix
    let values = raw.split('=').nth(1).unwrap_or("").to_lowercase();
    ["gnome-terminal", ..., "st-256color", "st", ...]
    .iter()
    .any(|t| {
        if t.len() <= 3 {
            values.contains(&format!("\"{}\"", t))
        } else {
            values.contains(*t)
        }
    })
        || values.contains("terminal")
        || values.contains("term")
})
```

That's it. No enigo→xdotool switch. No Escape workaround. No delay change. No windowactivate. Just fix the parsing.

---

## Roadmap

### Completed (This Session)
- [x] Identified "st" matching "STRING" bug as root cause
- [x] Verified detection returns correct results after fix
- [x] Confirmed xdotool paste works on this system
- [x] Tested paste in Chrome, text editor, terminal (all work)
- [x] Documented all findings and updated memory

### Unchanged Backlog (Pre-existing)
- [ ] Monitor upstream PR #1575 for review
- [ ] Investigate VAD "Failed to get recording stream" error
- [ ] Sync fork with upstream after PR merge or new release

### New Items Added (NEEDS CONFIRMATION)
- [ ] **NEW**: Reset fork to upstream/main and apply clean minimal fix
- [ ] **NEW**: Rebuild and install `.deb` after clean fix
- [ ] **ASSUMED**: User should change push-to-talk shortcut from Alt+D to a non-Alt combo for VS Code compatibility

---

## Quick Commands
```bash
cd /home/robert/Dev/epicenter

# Reset fork to upstream (DESTRUCTIVE — confirm first)
git checkout main
git fetch upstream
git reset --hard upstream/main
git push --force origin main

# Create clean fix branch
git checkout -b fix/terminal-paste-v2

# Apply the HTTP version pin fix
# Edit apps/whispering/src-tauri/Cargo.toml: tauri-plugin-http = "2.5.7"
# Then: cd apps/whispering/src-tauri && cargo update -p tauri-plugin-http

# Dev build
bun run --filter @epicenter/whispering dev

# Build release .deb
cd apps/whispering && bun x @tauri-apps/cli build

# Install .deb
sudo dpkg -i src-tauri/target/release/bundle/deb/Whispering_*.deb

# Check logs after testing
tail -20 ~/.local/share/com.bradenwong.whispering/logs/whispering.log
tail -20 ~/.local/share/com.bradenwong.whispering.dev/logs/whispering.log

# Check PR status
gh pr view 1575 --repo EpicenterHQ/epicenter
```

## Dependencies Added
- None (xdotool and xprop were already system dependencies)
