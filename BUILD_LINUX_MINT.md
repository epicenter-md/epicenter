# Building Whispering on Linux Mint (tray-icon fix + start-hidden)

This branch (`mint-tray-fix`) exists to build a **working** Whispering AppImage on
**Linux Mint** (and other Ubuntu 24.04–based distros). The official Linux build has
a couple of rough edges on Mint/Cinnamon; this branch fixes the tray icon and adds
an optional "boot straight to the tray, hidden" behavior that's handy for autostart.

It targets **Whispering v7.7.2** (commit `11fffee`), built as an **AppImage**.

---

## What's different from upstream

All changes are in `apps/whispering/src-tauri/`:

| Change | File | Why |
| --- | --- | --- |
| Bundle `recorder-state-icons/*` as a resource | `tauri.conf.json` | **The tray-icon fix.** The official build never ships these PNGs, so on Linux the tray fails to create its icon and never appears. Bundling them makes `resolveResource("recorder-state-icons/…")` succeed. |
| `app.windows[0].visible: false` | `tauri.conf.json` | **Start hidden.** The window no longer pops up on launch — the app lives in the tray. Ideal for autostart-on-login. Remove this if you want the window to show normally. |
| `createUpdaterArtifacts: false` | `tauri.conf.json` | The upstream config signs an auto-updater artifact, which requires Braden's private signing key. Self-builders don't have it, so the build would fail. We don't need the updater for a local build. |
| Single-instance handler `show()` + `unminimize()` + `set_focus()` | `src/lib.rs` | With the window starting hidden, relaunching the app (or clicking it in the menu) now reliably brings the window back instead of only focusing an already-visible one. |

> **Tray-icon gotcha (root cause, for the curious):** Tauri resolves bundled
> resources under `…/usr/lib/<productName>/`. Whispering's `productName` is
> `"Whispering"` (capital W), *not* the crate name `whispering`. The icons must
> land at `usr/lib/Whispering/recorder-state-icons/`. The `resources` glob in
> `tauri.conf.json` handles this automatically — no manual path juggling needed.

---

## Tested environment

- **Linux Mint 22.3** (Cinnamon, X11) — Ubuntu 24.04 "noble" base
- x86_64
- Rust 1.96, bun 1.3.0, LLVM/clang 18

---

## 1. System packages (the one step that needs `sudo`)

```bash
sudo apt update && sudo apt install -y \
  build-essential curl wget file pkg-config \
  libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev \
  libxdo-dev libasound2-dev \
  libclang-dev cmake libvulkan-dev glslc glslang-tools \
  patchelf
```

What each group is for:

- **Tauri / WebKit GUI:** `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libsoup-3.0-dev`
- **Tray icon:** `libayatana-appindicator3-dev`, `librsvg2-dev`
- **Native crates:** `libxdo-dev` (enigo / paste), `libasound2-dev` (cpal / audio)
- **whisper.cpp build:** `libclang-dev` (bindgen), `cmake`, and the **Vulkan**
  backend (`libvulkan-dev`, `glslc`, `glslang-tools`) — `transcribe-rs` enables the
  Vulkan feature of `whisper-rs` on Linux, so these are **required even if you have
  no GPU** (it falls back to CPU at runtime).
- **AppImage packaging:** `patchelf` (linuxdeploy's GStreamer plugin needs it)

## 2. Rust toolchain (no sudo)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustup component add rustfmt   # optional: silences a non-fatal bindgen warning
```

## 3. bun (no sudo)

```bash
curl -fsSL https://bun.sh/install | bash
# then restart your shell, or:
export PATH="$HOME/.bun/bin:$PATH"
```

(Or grab the binary directly from https://github.com/oven-sh/bun/releases if you
prefer not to pipe a script to your shell.)

## 4. Build the AppImage

```bash
git clone -b mint-tray-fix https://github.com/MC2018/epicenter.git
cd epicenter
bun install

cd apps/whispering

# Help bindgen find libclang (adjust the version if yours isn't llvm-18):
export LIBCLANG_PATH="$(dirname "$(find /usr/lib -name 'libclang.so*' 2>/dev/null | head -1)")"
# Make the AppImage packaging tools extract-and-run instead of FUSE-mounting:
export APPIMAGE_EXTRACT_AND_RUN=1

bun run tauri build --bundles appimage
```

The Rust compile (whisper.cpp + Vulkan shaders) takes a while on the first run.
The finished AppImage lands at:

```
apps/whispering/src-tauri/target/release/bundle/appimage/Whispering_7.7.2_amd64.AppImage
```

## 5. Install it

```bash
mkdir -p ~/Applications
cp apps/whispering/src-tauri/target/release/bundle/appimage/Whispering_7.7.2_amd64.AppImage \
   ~/Applications/Whispering.AppImage
chmod +x ~/Applications/Whispering.AppImage
```

### Add it to the menu / search

Create `~/.local/share/applications/whispering.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=Whispering
Comment=Press shortcut, speak, get text. Free and open source.
Exec=/home/YOURUSER/Applications/Whispering.AppImage
Icon=whispering
Terminal=false
Categories=Office;Utility;
StartupWMClass=whispering
```

(Optionally drop icons into `~/.local/share/icons/hicolor/{32x32,128x128,256x256}/apps/whispering.png`
and run `update-desktop-database ~/.local/share/applications` so it shows in search.)

### Autostart hidden on login

Copy the same file to `~/.config/autostart/whispering.desktop` (Cinnamon: or add it
via *Startup Applications*). Because this branch sets `visible: false`, it boots
straight to the tray with no window.

---

## Using it

- **Login:** starts silently in the tray (give it a few seconds for WebKit to spin up).
- **Open the window:** right-click the tray icon → **Show Window**, or click
  Whispering in the menu again (relaunch restores the hidden window).
- **Hide it again:** tray → **Hide Window**. **Quit:** tray → **Quit**.

## Notes / troubleshooting

- **`gst-plugins-bad` warnings** (WebVTT encoder, `fakevideosink`) on startup are
  harmless — they only affect subtitle handling in the webview, not transcription.
- **Tray icon doesn't appear?** Confirm the StatusNotifier host is running and that
  the bundled icons exist at `…AppDir/usr/lib/Whispering/recorder-state-icons/`
  (capital **W**). Extract with `./Whispering*.AppImage --appimage-extract` to check.
- **`Unable to find libclang`** during build → `LIBCLANG_PATH` isn't set/found;
  re-run the `export LIBCLANG_PATH=…` line above and confirm `libclang-dev` is installed.
- **`failed to run linuxdeploy` / `patchelf not found`** → install `patchelf`
  (it's in the apt list above) and set `APPIMAGE_EXTRACT_AND_RUN=1`.
