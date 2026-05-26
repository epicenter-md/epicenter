# Git Workflow

This repo is a fork of [EpicenterHQ/epicenter](https://github.com/EpicenterHQ/epicenter) with custom enhancements for Linux terminal paste support and dependency fixes.

| Remote | URL | Purpose |
|--------|-----|---------|
| `origin` | `https://github.com/rob88pt/epicenter.git` | Your fork -- push changes here |
| `upstream` | `https://github.com/EpicenterHQ/epicenter.git` | Original repo -- pull updates from here |

## Pushing Your Changes
```bash
git add <files> && git commit -m "message" && git push origin main
```

## Pulling Upstream Updates
```bash
git fetch upstream && git merge upstream/main
```

## Viewing Upstream Changes Before Merging
```bash
git fetch upstream
git log upstream/main --oneline --not main
git diff main upstream/main
```

## Tagging a Release
```bash
git tag -a v1.0.0 -m "Description" && git push origin v1.0.0
```

## Likely Conflict Files

These files contain our custom changes and are most likely to conflict when syncing upstream:

- `apps/whispering/src-tauri/src/lib.rs` -- terminal paste detection (Ctrl+Shift+V for terminals on Linux)
- `apps/whispering/src-tauri/Cargo.toml` -- pinned `tauri-plugin-http` version to 2.5.7
- `apps/whispering/src-tauri/Cargo.lock` -- dependency lock changes from the plugin update

When resolving conflicts in these files, prioritize keeping our terminal detection logic and HTTP plugin version while incorporating upstream feature changes.
