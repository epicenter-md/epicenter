# Technical Context

## Stack
- **Frontend:** Svelte 5 + TypeScript + Vite
- **Backend:** Rust (Tauri v2)
- **Transcription:** Groq cloud API (also supports local Whisper/Moonshine/Parakeet)
- **Audio:** cpal (Rust), ffmpeg (compression)
- **Keyboard simulation:** enigo 0.5.0
- **Key Dependencies:** tauri-plugin-http 2.5.7, tauri-plugin-clipboard-manager 2, groq-sdk (JS)

## Setup
```bash
# Install system deps (Ubuntu/Mint)
sudo apt install libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libasound2-dev libclang-dev libvulkan-dev glslc xdotool xprop

# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup default stable

# Install JS deps
bun install

# Dev mode
bun run --filter @epicenter/whispering dev

# Build release .deb
bun run --filter @epicenter/whispering build
cd apps/whispering && bun x @tauri-apps/cli build
# Output: apps/whispering/src-tauri/target/release/bundle/deb/Whispering_7.11.0_amd64.deb
```

## Environment
- **Bun:** package manager and runtime (not npm/yarn/node)
- **Rust:** stable toolchain via rustup
- **Required env vars:** GROQ_API_KEY (set in app settings UI, not env)

## Build & Deploy
- Dev: `bun run --filter @epicenter/whispering dev`
- Build frontend: `bun run --filter @epicenter/whispering build`
- Build installer: `cd apps/whispering && bun x @tauri-apps/cli build`
- Install: `sudo dpkg -i apps/whispering/src-tauri/target/release/bundle/deb/Whispering_7.11.0_amd64.deb`
