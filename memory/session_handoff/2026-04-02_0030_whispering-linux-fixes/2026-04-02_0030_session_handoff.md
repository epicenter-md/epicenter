# Epicenter (Whispering) - Session Handoff

**Date**: 2026-04-01 to 2026-04-02
**Location**: `/home/robert/Dev/epicenter`
**Session Goal**: Get the Whispering speech-to-text app working on Linux Mint, specifically fixing clipboard paste in terminals (Ctrl+Shift+V) and broken Groq cloud transcription.

---

## Chronological Narrative

### 1. Orientation & Setup
- **The Challenge**: User wanted to use the Whispering app from the epicenter monorepo on Linux Mint
- **Discovery**: The repo is a monorepo; Whispering lives in `apps/whispering/` as a Tauri (Svelte + Rust) desktop app
- **Decision**: Installed from the GitHub release `.deb` first, then moved to building from source to fix issues

### 2. Building from Source
- **The Problem**: Multiple missing system dependencies for Tauri on a fresh Linux Mint install
- **The Solution**: Installed in stages as errors appeared: Rust toolchain, libssl-dev, libclang-dev, libasound2-dev, libvulkan-dev, glslc, GTK/WebKit headers
- **Discovery**: `libappindicator3-dev` conflicts with `libayatana-appindicator3-dev` on modern Ubuntu/Mint -- must use the ayatana variant
- **Key Learning**: Full dependency list documented in `memory/tech_context.md`

### 3. Fixing Groq Transcription
- **The Problem**: After recording, transcription silently failed. Console showed: `Unhandled Promise Rejection: http.fetch_cancel_body not allowed. Command not found`
- **Investigation**: The JS `@tauri-apps/plugin-http` (v2.5.7 installed by bun) called `fetch_cancel_body`, but the Rust `tauri-plugin-http` (v2.5.4 pinned in Cargo.lock) didn't have that command
- **The Solution**: Pinned `tauri-plugin-http = "2.5.7"` in Cargo.toml, ran `cargo update -p tauri-plugin-http`
- **Dead End**: Initially tried adding explicit HTTP permissions (`http:allow-fetch-cancel` etc.) to capabilities/default.json -- this was wrong because `http:default` already includes all fetch permissions. The real issue was a version mismatch, not a permissions gap.

### 4. Fixing Terminal Paste
- **The Problem**: Whispering sends Ctrl+V to paste text, but terminals on Linux need Ctrl+Shift+V
- **The Solution**: Added terminal detection in `write_text` (lib.rs) -- checks WM_CLASS of the focused window against a list of known terminal emulators
- **Dead End**: First used `xdotool getwindowclassname` which doesn't exist in xdotool v3.20160805 (Ubuntu 24.04/Mint default). Switched to `xprop -id $(xdotool getactivewindow) WM_CLASS`

### 5. Dev/Prod Settings Migration
- **The Problem**: User wanted settings (API keys, model config) from the installed version in the dev build
- **Discovery**: Dev mode uses `http_localhost_1420` localstorage origin, production uses `tauri_localhost_0`. Copying the localstorage file doesn't work because the filenames differ by origin.
- **Resolution**: User re-entered API key manually in dev app settings

### 6. Fork, PR, and Release Build
- **Decision**: Forked to `rob88pt/epicenter`, created branch `fix/terminal-paste-and-http-plugin`
- **PR**: EpicenterHQ/epicenter#1575 opened with both fixes
- **Release**: Built patched `.deb` installer and installed it locally

### 7. Memory System Bootstrap
- **Decision**: Set up full project memory system with all core files, learnings, and error logs

---

## Current Technical State

- **Terminal Paste**: `write_text` in `lib.rs` detects terminal windows via `xprop WM_CLASS` on Linux. Sends Ctrl+Shift+V for terminals, Ctrl+V for everything else. macOS/Windows unchanged.
- **HTTP Plugin**: `tauri-plugin-http` pinned to 2.5.7 in Cargo.toml, matching the JS plugin version. Groq transcription confirmed working in dev build.
- **Installed Version**: Patched `.deb` installed locally at `/usr/bin/whispering`. Includes both fixes but terminal paste not yet verified in release build.

---

## Files Changed

### Created
| File | Purpose |
|------|---------|
| `docs/git-workflow.md` | Fork workflow, remotes, sync commands, conflict file list |
| `memory/active_context.md` | Current focus and session state |
| `memory/task_list.md` | Persistent task backlog |
| `memory/changelog.md` | Detailed change history |
| `memory/changelog_summary.md` | Lean summary for quick reads |
| `memory/decisions.md` | ADRs for xprop detection and HTTP version pinning |
| `memory/project_brief.md` | Project goals and scope |
| `memory/tech_context.md` | Stack, setup commands, build instructions |
| `memory/learnings/LEARNINGS.md` | 3 learnings logged |
| `memory/learnings/ERRORS.md` | 3 errors logged with resolutions |

### Modified
| File | What Changed |
|------|-------------|
| `apps/whispering/src-tauri/src/lib.rs` | Added terminal detection via xprop, Ctrl+Shift+V for terminals |
| `apps/whispering/src-tauri/Cargo.toml` | Pinned `tauri-plugin-http = "2.5.7"` |
| `apps/whispering/src-tauri/Cargo.lock` | Updated tauri-plugin-http and transitive deps |

### Key Reference Files
| File | Why It Matters |
|------|---------------|
| `apps/whispering/src-tauri/src/lib.rs:210-295` | `write_text` command -- clipboard sandwich + terminal detection |
| `apps/whispering/src-tauri/capabilities/default.json` | Tauri permission config for HTTP, clipboard, etc. |
| `apps/whispering/src/lib/services/transcription/cloud/groq.ts` | Groq API transcription service |
| `apps/whispering/src/lib/services/http/tauri-fetch.ts` | Custom fetch that routes through Tauri HTTP plugin |

---

## Problems Faced & Solutions

| Problem | Solution |
|---------|----------|
| Missing system deps for Tauri build (libssl, libclang, ALSA, Vulkan) | Installed all dev packages -- see `memory/tech_context.md` |
| `libappindicator3-dev` conflicts with ayatana variant | Use `libayatana-appindicator3-dev` instead |
| `http.fetch_cancel_body not allowed` breaking Groq transcription | JS plugin v2.5.7 ahead of Rust v2.5.4 -- updated Rust to 2.5.7 |
| `xdotool getwindowclassname` not found | xdotool v3.20160805 lacks it -- used `xprop` instead |
| Dev/prod localstorage origins differ | Can't copy settings between builds -- re-enter manually |
| `pkill` killed both old and new process | Launch without killing first, or use `fuser -k` on the port |

---

## Next Session Action Plan

1. **Verify terminal paste in release build** -- launch installed Whispering, record, and paste into GNOME Terminal
2. **Monitor PR #1575** -- check for upstream review comments or merge
3. **Investigate VAD errors** -- "Failed to get recording stream" appears when voice-activated capture mode tries to start
4. **Sync fork** -- after upstream merges or releases, pull changes

---

## Roadmap

### Completed (This Session)
- [x] Fork EpicenterHQ/epicenter to rob88pt/epicenter
- [x] Fix terminal paste (Ctrl+Shift+V detection via xprop)
- [x] Fix Groq transcription (tauri-plugin-http version mismatch)
- [x] Build and install patched `.deb`
- [x] Open upstream PR #1575
- [x] Set up project memory system
- [x] Create git-workflow.md

### Unchanged Backlog (Pre-existing)
- [ ] Verify terminal paste in release build
- [ ] Monitor upstream PR review
- [ ] Investigate VAD recording stream errors
- [ ] Sync fork with upstream after merge/release

### New Items Added (NEEDS CONFIRMATION)
- [ ] **ASSUMED**: May need Wayland support for terminal detection (xprop is X11 only)

---

## Quick Commands
```bash
cd /home/robert/Dev/epicenter

# Dev mode
bun run --filter @epicenter/whispering dev

# Build release .deb
bun run --filter @epicenter/whispering build
cd apps/whispering && bun x @tauri-apps/cli build

# Install .deb
sudo dpkg -i apps/whispering/src-tauri/target/release/bundle/deb/Whispering_7.11.0_amd64.deb

# Check fork status
git remote -v
git fetch upstream
git log upstream/main --oneline --not main

# Check PR
gh pr view 1575 --repo EpicenterHQ/epicenter
```

## Dependencies Added
- `tauri-plugin-http` updated 2.5.4 -> 2.5.7 (Rust side, to match JS plugin)
- System packages: libssl-dev, libgtk-3-dev, libwebkit2gtk-4.1-dev, libayatana-appindicator3-dev, librsvg2-dev, patchelf, libsoup-3.0-dev, libjavascriptcoregtk-4.1-dev, libasound2-dev, libclang-dev, libvulkan-dev, glslc
