# Changelog Summary

## Current State
Fork has extra changes on `fix/terminal-paste-and-http-plugin` branch that should be discarded. Plan: reset to upstream/main and apply only the essential terminal detection fix (parse xprop values correctly, exact match for short names like "st").

## Major Milestones
- **[2026-04-01]** Forked repo, fixed terminal paste and Groq transcription, opened upstream PR #1575
- **[2026-04-02]** Found and fixed critical "st" matching bug in terminal detection. Discovered several unnecessary changes made while debugging — plan to start fresh.

## Key Decisions
- Use `xprop` for WM_CLASS detection instead of newer xdotool commands (see [[decisions.md]] ADR-001)
- Pin `tauri-plugin-http = "2.5.7"` explicitly to prevent JS/Rust version drift
- Keep changes minimal to avoid merge conflicts with upstream
- Alt-based shortcuts (Alt+D) activate menu bars in VS Code — not a code bug, user should use non-Alt shortcuts

## Recent Focus
- Debugging paste issues across different Linux apps
- Isolating the real bug ("st" matching "STRING") from symptoms (menu activation from Alt shortcuts)
