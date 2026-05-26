# Architecture Decision Records

## ADR-001: Use xprop for Terminal Window Detection
- **Date:** 2026-04-01
- **Status:** accepted

### Context
Whispering sends Ctrl+V to paste transcribed text, but terminals on Linux use Ctrl+Shift+V. Need to detect whether the focused window is a terminal at paste time.

### Decision
Use `xprop -id $(xdotool getactivewindow) WM_CLASS` to get the focused window's class, then check against a list of known terminal emulator names.

### Rationale
- `xdotool getwindowclassname` would be simpler but doesn't exist in xdotool v3.20160805 shipped with Ubuntu 24.04 / Linux Mint
- `xprop` is universally available on X11 systems
- Checking WM_CLASS against a list plus "terminal"/"term" substring fallback covers most emulators
- Runs as a shell subprocess which adds ~5ms latency -- acceptable since it runs once per paste

### Consequences
- Positive: Works on all common Linux distros without extra dependencies
- Positive: Fallback matching catches most terminals not in the explicit list
- Negative: Won't work on pure Wayland (no X11) -- would need a different approach
- Negative: Shell subprocess per paste has minor overhead

## ADR-002: Pin tauri-plugin-http Version
- **Date:** 2026-04-01
- **Status:** accepted

### Context
The JS `@tauri-apps/plugin-http` (v2.5.7) called `fetch_cancel_body` but the Rust `tauri-plugin-http` (v2.5.4 via `"2"` semver) didn't have that command, causing all HTTP requests to fail silently.

### Decision
Pin `tauri-plugin-http = "2.5.7"` explicitly in Cargo.toml instead of using `"2"`.

### Rationale
- The semver `"2"` resolved to 2.5.4 due to Cargo.lock pinning, while bun installed JS plugin 2.5.7
- Explicit version prevents future mismatches between JS and Rust sides
- Both sides should always be on the same minor version

### Consequences
- Positive: Prevents silent HTTP failures from version drift
- Negative: Requires manual version bumps when updating the JS plugin
