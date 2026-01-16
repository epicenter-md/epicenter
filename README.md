# Whispering

Private fork of [Epicenter Whispering](https://github.com/EpicenterHQ/epicenter) - Desktop speech-to-text transcription app.

## Features

- Press shortcut, speak, get text
- Local-first with optional cloud transcription
- Supports OpenAI Whisper API and local models (Canary)
- Cross-platform: macOS, Windows, Linux

## Tech Stack

- **Frontend**: Svelte 5, TypeScript, TailwindCSS
- **Backend**: Tauri (Rust)
- **Transcription**: OpenAI Whisper API, Canary local model

## Development

### Prerequisites

- [Bun](https://bun.sh) (latest)
- [Rust](https://www.rust-lang.org/tools/install)

### Setup

```bash
bun install
cd apps/whispering
bun dev
```

### Build

```bash
cd apps/whispering
bun tauri build
```

### Troubleshooting

```bash
# Clear caches
bun clean
bun install

# Full reset (includes Rust target, ~10GB)
bun nuke
bun install
```

## Project Structure

```
apps/
  whispering/     # Main desktop app (Tauri + Svelte)
packages/
  ui/             # Shared UI components
  config/         # Shared configuration
```

## License

[AGPL-3.0](LICENSE) - Based on [EpicenterHQ/epicenter](https://github.com/EpicenterHQ/epicenter)
