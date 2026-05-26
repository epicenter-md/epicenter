# Error Log

Specific errors, their causes, and resolutions.

---

### ERR-001: xdotool: Unknown command: getwindowclassname
- **Logged:** 2026-04-01
- **Area:** backend
- **Priority:** high
- **Error:** `xdotool: Unknown command: getwindowclassname`
- **Cause:** xdotool v3.20160805 (Ubuntu 24.04/Mint default) doesn't include `getwindowclassname`. This command was added in a later version.
- **Fix:** Replace with `xprop -id $(xdotool getactivewindow) WM_CLASS 2>/dev/null` which works on all X11 systems.
- **Prevention:** Don't use newer xdotool commands without checking version compatibility. Prefer xprop for window property queries.
- **Status:** resolved

---

### ERR-002: http.fetch_cancel_body not allowed. Command not found
- **Logged:** 2026-04-01
- **Area:** config
- **Priority:** critical
- **Error:** `Unhandled Promise Rejection: http.fetch_cancel_body not allowed. Command not found`
- **Cause:** JS `@tauri-apps/plugin-http` v2.5.7 calls `fetch_cancel_body` command, but Rust `tauri-plugin-http` v2.5.4 doesn't define it. The command was added in a later Rust plugin version.
- **Fix:** Update `tauri-plugin-http` in Cargo.toml from `"2"` to `"2.5.7"` and run `cargo update -p tauri-plugin-http`.
- **Prevention:** When updating JS Tauri plugins via bun, always check and update the corresponding Rust crate version in Cargo.toml to match.
- **Status:** resolved

---

### ERR-003: Missing system libraries for Tauri build on Linux Mint
- **Logged:** 2026-04-01
- **Area:** infra
- **Priority:** medium
- **Error:** Multiple: `pkg-config exited with status code 1` (alsa), `Unable to find libclang`, `Could NOT find Vulkan`
- **Cause:** Fresh Linux Mint install missing development headers for ALSA, libclang, Vulkan, OpenSSL, GTK, WebKit.
- **Fix:** `sudo apt install libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libasound2-dev libclang-dev libvulkan-dev glslc`
- **Prevention:** See `memory/tech_context.md` for full setup command. Note: use `libayatana-appindicator3-dev` not `libappindicator3-dev` on newer Ubuntu/Mint (conflicts with ayatana variant).
- **Status:** resolved

---

### ERR-004: "st" in terminal list matches "STRING" in xprop output
- **Logged:** 2026-04-02
- **Area:** backend
- **Priority:** critical
- **Error:** Every window falsely detected as terminal — Ctrl+Shift+V sent to all apps. LibreOffice shows Paste Special dialog, VS Code toggles Markdown preview, Chrome pastes as plain text (masking the issue).
- **Cause:** `xprop` output format is `WM_CLASS(STRING) = "instance", "class"`. The terminal detection code checked if the ENTIRE output line contained any terminal name. `"st"` (suckless terminal) matched the `ST` in `STRING`.
- **Fix:** Parse only the values after `=` in xprop output. For short names (≤3 chars like "st"), use exact quoted matching: `values.contains("\"st\"")` instead of `values.contains("st")`.
- **Prevention:** When matching against structured command output, always parse the relevant values first — never match against the entire output including format prefixes. Test with diverse apps (not just terminal and Chrome).
- **Status:** resolved
