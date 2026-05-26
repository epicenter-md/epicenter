# Learnings Log

Discoveries, patterns, and non-obvious solutions. Recurring patterns get promoted to CLAUDE.md.

---

### LRN-001: xdotool version differences across distros
- **Logged:** 2026-04-01
- **Area:** backend
- **Priority:** high
- **Pattern-Key:** linux.xdotool_version_compat
- **Recurrence-Count:** 1
- **First-Seen:** 2026-04-01
- **Last-Seen:** 2026-04-01
- **Context:** xdotool v3.20160805 (shipped with Ubuntu 24.04/Mint) does not have `getwindowclassname`. Newer versions do. Code that uses xdotool must account for older versions.
- **Resolution:** Use `xprop -id $(xdotool getactivewindow) WM_CLASS` as a portable alternative. Works on all X11 systems regardless of xdotool version.
- **See Also:** ERR-001
- **Status:** pending

---

### LRN-002: Tauri JS/Rust plugin version sync is critical
- **Logged:** 2026-04-01
- **Area:** config
- **Priority:** critical
- **Pattern-Key:** tauri.plugin_version_sync
- **Recurrence-Count:** 1
- **First-Seen:** 2026-04-01
- **Last-Seen:** 2026-04-01
- **Context:** `bun install` updates JS plugins to latest semver-compatible version, but `cargo build` uses Cargo.lock which may pin an older Rust version. The JS side can call commands that don't exist in the older Rust side, causing silent failures.
- **Resolution:** Pin exact versions in Cargo.toml to match the JS plugin version. Check both `package.json` and `Cargo.lock` versions when debugging Tauri plugin errors.
- **See Also:** ERR-002
- **Status:** pending

---

### LRN-003: Tauri dev vs production use different localstorage origins
- **Logged:** 2026-04-01
- **Area:** config
- **Priority:** medium
- **Pattern-Key:** tauri.dev_prod_storage_origin
- **Recurrence-Count:** 1
- **First-Seen:** 2026-04-01
- **Last-Seen:** 2026-04-01
- **Context:** Dev mode uses `http_localhost_1420` origin, production uses `tauri_localhost_0`. WebView localstorage (API keys, settings) is scoped to origin, so copying the localstorage file between dev/prod doesn't work -- different filenames.
- **Resolution:** Re-enter settings manually in dev mode, or rename the localstorage file to match the target origin.
- **See Also:** --
- **Status:** pending

---

### LRN-004: xprop output format causes substring matching bugs
- **Logged:** 2026-04-02
- **Area:** backend
- **Priority:** critical
- **Pattern-Key:** linux.xprop_output_parsing
- **Recurrence-Count:** 1
- **First-Seen:** 2026-04-02
- **Last-Seen:** 2026-04-02
- **Context:** `xprop -id <id> WM_CLASS` outputs `WM_CLASS(STRING) = "instance", "class"`. The word `STRING` in the prefix contains `st`, which matched the suckless terminal entry `"st"` in the terminal list. Every window was falsely detected as a terminal.
- **Resolution:** Parse only the values after `=` (not the full output line). For short names (≤3 chars), use exact quoted matching: check for `"st"` not just `st` as a substring.
- **See Also:** LRN-001
- **Status:** pending

---

### LRN-005: Alt keyboard shortcuts activate menu bars in Linux apps
- **Logged:** 2026-04-02
- **Area:** backend
- **Priority:** medium
- **Pattern-Key:** linux.alt_key_menu_activation
- **Recurrence-Count:** 1
- **First-Seen:** 2026-04-02
- **Last-Seen:** 2026-04-02
- **Context:** Using Alt+D as a push-to-talk shortcut causes VS Code (and other apps) to activate the File menu bar when Alt is released. This steals focus from the editor, making subsequent paste operations fail. Not a code bug — standard OS/DE behavior.
- **Resolution:** Use non-Alt shortcuts for push-to-talk when using VS Code or other apps with Alt-activated menus. Ctrl+Shift combos are safer.
- **See Also:** --
- **Status:** pending

---

### LRN-006: Iterate with logging, don't speculate on root causes
- **Logged:** 2026-04-02
- **Area:** process
- **Priority:** high
- **Pattern-Key:** debugging.log_first_speculate_later
- **Recurrence-Count:** 1
- **First-Seen:** 2026-04-02
- **Last-Seen:** 2026-04-02
- **Context:** Spent significant time speculating about stuck modifier keys, enigo vs xdotool, timing issues, and focus stealing — all wrong. The actual bug was the "st" matching "STRING" in xprop output, found in seconds once we added logging and checked.
- **Resolution:** Add logging first, reproduce, read logs. Don't stack changes based on theories. Apply one fix at a time and test.
- **See Also:** --
- **Status:** pending
