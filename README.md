<p align="center">
  <a href="https://epicenter.so">
    <img width="200" src="https://github.com/user-attachments/assets/9e210c52-2740-43b6-af3f-e6eaf4b5c397" alt="Epicenter">
  </a>
  <h1 align="center">Epicenter</h1>
  <p align="center">Local-first, open-source apps</p>
  <p align="center">Own your data. Use any model you want. Free and open source ❤️</p>
</p>

> **📢 Repository Update:** Whispering has become **Epicenter**! The original repository moved [here](https://github.com/epicenter-md/epicenter/tree/main/apps/whispering). Everything else remains the same—same tools, same philosophy, same team.
>
> <details>
> <summary> Full details...
> </summary>
>
> - Whispering's evolution beyond transcription required changes to the repository's structure and branding.
> - Everything else remains the same—same tools, same philosophy, same team.
> - The original app lives on as [*Epicenter Whispering*](https://github.com/epicenter-md/epicenter/tree/main/apps/whispering), keeping a tight focus on transcription.
> - This makes room for standalone apps with complementary, but non-transcription-related features (like [*Epicenter Assistant*](https://github.com/epicenter-md/epicenter/tree/main/apps/sh)).
> - The new [root](https://github.com/epicenter-md/epicenter/) of the Epicenter repository contains common files supporting all the apps in the ecosystem.
> - Note: the old URL [github.com/braden-w/whispering](https://github.com/braden-w/whispering) is now just a thin placeholder redirecting to this rebranded repository.
>
> </details>

<p align="center">
  <!-- GitHub Stars Badge -->
  <a href="https://github.com/epicenter-md/epicenter" target="_blank">
    <img alt="GitHub stars" src="https://img.shields.io/github/stars/epicenter-md/epicenter?style=flat-square" />
  </a>
  <!-- Latest Version Badge -->
  <img src="https://img.shields.io/github/v/release/epicenter-md/epicenter?style=flat-square&label=Latest%20Version&color=brightgreen" />
  <!-- License Badge -->
  <a href="LICENSE" target="_blank">
    <img alt="MIT License" src="https://img.shields.io/github/license/epicenter-md/epicenter.svg?style=flat-square" />
  </a>
  <!-- Discord Badge -->
  <a href="https://go.epicenter.so/discord" target="_blank">
    <img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&logo=discord&logoColor=white" />
  </a>
  <!-- Platform Support Badges -->
  <a href="https://github.com/epicenter-md/epicenter/releases" target="_blank">
    <img alt="macOS" src="https://img.shields.io/badge/-macOS-black?style=flat-square&logo=apple&logoColor=white" />
  </a>
  <a href="https://github.com/epicenter-md/epicenter/releases" target="_blank">
    <img alt="Windows" src="https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=windows&logoColor=white" />
  </a>
  <a href="https://github.com/epicenter-md/epicenter/releases" target="_blank">
    <img alt="Linux" src="https://img.shields.io/badge/-Linux-yellow?style=flat-square&logo=linux&logoColor=white" />
  </a>
</p>

<p align="center">
  <a href="#current-tools">Tools</a> •
  <a href="#where-were-headed">Vision</a> •
  <a href="#join-us">Contributing</a> •
  <a href="https://go.epicenter.so/discord">Discord</a> •
</p>

---

## What is Epicenter?

Epicenter is an ecosystem of open-source, local-first apps. Our eventual goal is to store all of your data—notes, transcripts, chat histories—in a single folder of plain text and SQLite. Every tool we build shares this memory. It's open, tweakable, and yours. Grep it, open it in Obsidian, host it wherever you like. The choice is yours.

### The Vision (how the ecosystem will work):

- Long-time Epicenter Whispering users may have configured numerous LLM API keys, transformations, and even local models.
- When the Epicenter Assistant is started for the very first time, all these API keys, transformations and local models seamlessly work.
- Epicenter Assistant may even access Whispering transcription history to provide personalized results out of the box.
- Of course, this works the other way, too: Whispering can take advantage of your Epicenter Assistant history to optimize transcriptions and transformations!
- In a siloed ecosystem, this requires much more effort, or may not even be possible.

## Current Tools

<table>
  <tr>
    <td align="center" width="50%">
      <h3>🎙️ <a href="https://github.com/epicenter-md/epicenter/tree/main/apps/whispering">Epicenter Whispering</a></h3>
      <p>Press shortcut → speak → get text. Desktop transcription that cuts out the middleman. Bring your own API key.</p>
      <p><strong>→ <a href="https://github.com/epicenter-md/epicenter/tree/main/apps/whispering">View source code</a></strong></p>
    </td>
    <td align="center" width="50%">
      <h3>
        🤖 <a href="https://github.com/epicenter-md/epicenter/tree/main/apps/sh">Epicenter Assistant</a>
        (currently unstable, waiting for 
        <a href="https://github.com/sst/opencode/pull/1218">this PR</a> in OpenCode to merge)
      </h3>
      <p>A local-first assistant you can chat with. It lives in your folder, becoming the access point to everything you've ever written, thought, or built.</p>
      <p><strong>→ <a href="https://github.com/epicenter-md/epicenter/tree/main/apps/sh">View source code</a></strong></p>
    </td>
  </tr>
</table>

## Where We're Headed

Our vision is to build a personal workspace where you own your data, choose your models, and replace siloed apps with open, interoperable alternatives. All while preserving authenticity and being free and open source.

## Quick Start

### Install Epicenter Whispering

Our first app in the ecosystem. Choose your installation method:

**macOS (Homebrew)**
```bash
brew install --cask epicenter-whispering
```

**macOS, Windows, Linux (Direct Download)**

Download the installer for your platform from [GitHub Releases](https://github.com/epicenter-md/epicenter/releases/latest):
- macOS: `.dmg` (Apple Silicon or Intel)
- Windows: `.msi` or `.exe`
- Linux: `.AppImage`, `.deb`, or `.rpm`

**→ [Full installation guide and setup instructions](https://github.com/epicenter-md/epicenter/tree/main/apps/whispering#install-whispering)**

### Build from Source

For developers or contributors:

```bash
# Prerequisites:
# - Install Bun from https://bun.sh (run bun upgrade if there's issues)
# - Install Rust and Cargo from https://www.rust-lang.org/tools/install (brew install rustup)

git clone https://github.com/epicenter-md/epicenter.git
cd epicenter
bun install  # Will prompt to upgrade if your Bun version is too old
cd apps/whispering
bun dev
```

### Alternative: Using Nix (Deterministic Development Environment)

If you have [Nix](https://nixos.org/download) installed, you can get a complete, reproducible development environment with all dependencies pre-configured:

```bash
git clone https://github.com/epicenter-so/epicenter.git
cd epicenter
nix run .#dev  # Builds and runs Whispering desktop app
# OR
nix run .#web-dev  # Runs web version only
# OR  
nix develop  # Enters development shell with all tools available
```

The Nix flake provides:
- Complete Rust toolchain with all necessary targets
- Bun, Node.js, and all build tools
- All GTK/WebKit system dependencies for Tauri
- Audio libraries for transcription features
- Deterministic, reproducible builds across machines

## Join Us

## Discord Community

If you think like a generalist, build like a hacker, and value tools that respect your mind—you'll fit right in.

**→ [Join our Discord](https://go.epicenter.so/discord)**

### We're looking for contributors

If you're passionate about open source, local-first software, or are just a cracked Svelte/TypeScript developer—we'd love to build with you.

**→ [Read our Contributing Guide](CONTRIBUTING.md) to get started**

Contributors coordinate and share ideas in our Discord community.

## Tech Stack

<p align="center">
  <img alt="Svelte 5" src="https://img.shields.io/badge/-Svelte%205-orange?style=flat-square&logo=svelte&logoColor=white" />
  <img alt="Tauri" src="https://img.shields.io/badge/-Tauri-blue?style=flat-square&logo=tauri&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/-TypeScript-blue?style=flat-square&logo=typescript&logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/-Rust-orange?style=flat-square&logo=rust&logoColor=white" />
  <img alt="TanStack Query" src="https://img.shields.io/badge/-TanStack%20Query-red?style=flat-square&logo=react-query&logoColor=white" />
  <img alt="Tailwind CSS" src="https://img.shields.io/badge/-Tailwind%20CSS-38B2AC?style=flat-square&logo=tailwind-css&logoColor=white" />
</p>

## License

[MIT](LICENSE). Build on it. Fork it. Make it yours. Please contribute if you can.

---

<p align="center">
  <strong>Contact:</strong> <a href="mailto:github@bradenwong.com">github@bradenwong.com</a> | <a href="https://go.epicenter.so/discord">Discord</a> | <a href="https://twitter.com/braden_wong_">@braden_wong_</a>
</p>

<p align="center">
  <sub>Built with ❤️ for data ownership, local-first, and open-source</sub>
</p>
