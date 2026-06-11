# Home Dotfiles Beat XDG for Developer Tools

> **Note (2026-05-22)**: This article is superseded. Current Epicenter does not write machine-wide auth, runtime files, logs, or global persistence under top-level `~/.epicenter/`. Machine auth uses the platform data directory from `env-paths('epicenter')`, daemon runtime files use the OS runtime directory, daemon logs use the platform log directory, and generated project data stays under `<projectDir>/.epicenter/`.

We wrote an article a few months ago arguing for XDG compliance. The position was that `~/.config/` is the correct place for application settings, `~/.local/share/` for data, and apps that dump dotfiles in `~/` are "bad citizens." That argument is technically correct and practically wrong for developer tools.

Here's what the tools developers actually use every day chose:

| Tool               | Config Location                                            | Convention                 |
| ------------------ | ---------------------------------------------------------- | -------------------------- |
| Claude Code        | `~/.claude/`                                               | Home dotfile               |
| Ollama             | `~/.ollama/`                                               | Home dotfile               |
| Cursor             | `~/.cursor/`                                               | Home dotfile               |
| OpenCode           | `~/.config/opencode/`                                      | XDG                        |
| Whispering (Tauri) | `~/Library/Application Support/com.bradenwong.whispering/` | Platform-specific app data |

Four out of five chose home dotfiles. The one that chose XDG is the one you have to remember the path for.

## Why XDG Loses in Practice

XDG solves a real problem: organizing config vs data vs cache into predictable locations. On a shared Linux server with 50 users, this matters. On a developer's personal machine running Ollama and Claude Code, nobody has ever thought "I wish this was in `~/.local/share/` instead of `~/`."

The XDG spec splits a single app's files across three directories. Your Claude Code config is in `~/.config/claude/`, your data in `~/.local/share/claude/`, your cache in `~/.cache/claude/`. Want to back up everything Claude-related? Search three places. Want to nuke it? Delete from three directories. Want to find it? Remember which bucket each file falls into.

Home dotfiles put everything in one place: `ls -la ~ | grep claude`. Done.

## Discoverability Is the Feature

The argument for `~/.config/` assumes users organize by file type: config here, data there, cache over there. Real developers organize by tool: "where's my Ollama stuff?" not "where's my configuration files?"

```bash
# XDG: three commands to find everything
ls ~/.config/ollama/
ls ~/.local/share/ollama/
ls ~/.cache/ollama/

# Home dotfile: one command
ls ~/.ollama/
```

This is why Claude, Ollama, and Cursor all chose home dotfiles over XDG. Discoverability matters more than spec compliance for tools developers interact with daily.

## Epicenter's Centralized Store

Epicenter follows the same model as Homebrew. All workspaces live under `~/.epicenter/workspaces/`, each in its own self-contained directory with its config, providers, and dependencies:

```
~/.epicenter/
  ├── server/
  │   └── config.json        ← API keys, allowed origins
  └── workspaces/
      ├── blog/
      │   ├── epicenter.config.ts
      │   ├── package.json
      │   ├── node_modules/
      │   └── .epicenter/
      │       └── providers/
      │           ├── persistence/
      │           ├── sqlite/
      │           └── markdown/
      ├── habits/
      │   └── ...
      └── notes/
          └── ...
```

One directory to back up, one directory to nuke, one directory to `ls`. The app server discovers workspaces by reading `~/.epicenter/workspaces/`: no registry file, no scattered project folders to track down.

This mirrors how Homebrew puts everything in `/opt/homebrew/Cellar/` and how Cargo puts everything in `~/.cargo/`. A single, predictable location that you can find with your eyes closed.

## When XDG Is Still Right

XDG works well for system-level services, daemons, and apps that genuinely benefit from separating config from data from cache. A desktop email client with gigabytes of cached attachments and a 2KB config file? XDG makes sense there; users back up `~/.config/` and skip `~/.cache/`.

Developer tools are different. Their "config" and "data" are intertwined: your `.claude/` directory has settings, history, transcripts, and todo files all mixed together. Splitting them across XDG directories would create friction without benefit.

## The Decision

Epicenter's global config and all workspace data live under `~/.epicenter/`. Home dotfile, not XDG. The same convention as Claude Code, Ollama, and Cursor, because we'd rather be easy to find than spec-compliant.
