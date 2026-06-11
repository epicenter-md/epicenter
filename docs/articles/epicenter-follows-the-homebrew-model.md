# Epicenter Follows the Homebrew Model

> **Note (2026-05-22)**: This article documents an earlier storage model. Current Epicenter does not store global workspace data under top-level `~/.epicenter/`. Machine auth uses the platform data directory from `env-paths('epicenter')`, daemon runtime files use the OS runtime directory, daemon logs use the platform log directory, and generated workspace data stays under each project at `<projectDir>/.epicenter/`.

Homebrew, Cargo, Docker, and Epicenter all solve the same organizational problem: give users one predictable root directory, put self-contained units inside it, and discover everything with a single directory scan. The convention is old and boring. That's the point.

## One Root, Self-Contained Units

Run `ls /opt/homebrew/Cellar/` and you see every package Homebrew manages. Each one is a directory containing a version folder with its own `bin/`, `lib/`, `share/`: everything it needs to function. The top-level `bin/` is just a symlink farm.

```
/opt/homebrew/
├── Cellar/
│   ├── gh/2.87.3/
│   │   ├── bin/gh
│   │   ├── share/man/
│   │   └── INSTALL_RECEIPT.json
│   ├── ffmpeg/7.x/
│   │   ├── bin/ffmpeg
│   │   ├── lib/
│   │   └── share/
│   └── ...
├── bin/gh → ../Cellar/gh/2.87.3/bin/gh
└── opt/gh → ../Cellar/gh/2.87.3
```

Epicenter's workspace directory is the same model at a different scope:

```
~/.epicenter/
└── workspaces/
    ├── habit-tracker/
    │   ├── epicenter.config.ts
    │   ├── package.json
    │   ├── node_modules/
    │   └── .epicenter/providers/...
    ├── bookmarks/
    │   ├── epicenter.config.ts
    │   ├── package.json
    │   ├── node_modules/
    │   └── .epicenter/providers/...
    └── ...
```

The Cellar contains Homebrew packages. `~/.epicenter/workspaces/` contains Epicenter workspaces. Discovery is the same in both: `readdir()` the parent, look for the expected marker inside each child. Homebrew checks for `INSTALL_RECEIPT.json`; Epicenter checks for `epicenter.config.ts`.

## Self-Contained Means Self-Contained

Each Homebrew package in the Cellar has its own complete tree. It doesn't share binaries with its neighbors or rely on a global `lib/` to function (the symlink farm is a convenience, not a dependency). Delete a Cellar entry, nothing else breaks.

Epicenter workspaces follow the same rule. Each workspace folder has its own `node_modules/` with `@epicenter/workspace` installed locally.

```
~/.epicenter/workspaces/habit-tracker/
├── epicenter.config.ts          ← schema + extensions + actions
├── package.json                 ← depends on @epicenter/workspace
├── node_modules/                ← resolved locally (Bun hard-links to global cache)
│   └── @epicenter/workspace/
└── .epicenter/
    └── providers/
        ├── persistence/habits.yjs
        └── sqlite/habits.db
```

Why not a shared root `node_modules/`? Same reason Homebrew doesn't share a global `lib/`: version independence. Two workspaces might pin different versions of `@epicenter/workspace`. A habits tracker built six months ago shouldn't break because a bookmarks workspace upgraded.

Bun makes this cheap. Its global cache means per-workspace `node_modules/` are hard links, not copies. The disk cost is near-zero; the isolation is real.

## Discovery Is Just readdir()

This is where the centralized model pays off most clearly. Homebrew discovers packages by listing the Cellar. One `readdir()`. Epicenter does the same:

```typescript
const entries = await readdir(join(epicenterHome, 'workspaces'), { withFileTypes: true });

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const configPath = join(wsDir, entry.name, 'epicenter.config.ts');
  if (!(await Bun.file(configPath).exists())) continue;

  const mod = await import(Bun.pathToFileURL(configPath).href);
  const client = extractWorkspaceClient(mod);
  clients.set(client.id, client);
}
```

No cache file. No self-registration. No stale path pruning. The filesystem is the source of truth.

An earlier design allowed workspaces to live anywhere on the filesystem: `~/projects/blog/epicenter.config.ts`, `~/notes/epicenter.config.ts`, with a `known-workspaces.json` cache pointing to all of them. That was dropped. Browser configs diverge from server configs anyway (different action sets, no FS extensions), so the "workspace alongside my project" use case doesn't hold up. Every comparable tool uses centralized storage: Obsidian, VS Code, Docker, Homebrew. None do recursive filesystem scanning as primary discovery.

## Why /opt/ Is Wrong for Epicenter

Homebrew uses `/opt/homebrew/` because it manages system-level binaries that need to be on `$PATH` for all terminal sessions. That location requires elevated permissions and exists outside any user's home directory, which is appropriate for shared system tools.

Epicenter manages user-level workspace data: Yjs documents, SQLite databases, markdown files. This is personal data that belongs in userspace. Putting it in `/opt/` would require `sudo` to install a workspace, break multi-user setups without per-user subdirectories, and collide if two users want different workspace versions. `~/.epicenter/` is the right scope. Same organizational principle as `/opt/homebrew/`, applied at the user level where workspace data belongs.

## The Pattern

Homebrew, Cargo, Docker, and Epicenter all converge on the same design:

```
{root}/
├── {unit-a}/    ← self-contained, own deps
├── {unit-b}/    ← self-contained, own deps
└── {unit-c}/    ← self-contained, own deps
```

The root location differs based on what the tool manages: `/opt/homebrew/Cellar/` for system binaries, `~/.cargo/registry/` for Rust crates, `~/.epicenter/workspaces/` for workspace data. The internal model is identical: one predictable directory, self-contained children, discovery by scanning.

The model works because it trades storage efficiency for operational simplicity. Each workspace duplicating its own `node_modules/` wastes disk space in theory (in practice, Bun's hard links make this nearly free). But it means `epicenter install habit-tracker` just works, `epicenter uninstall habit-tracker` is `rm -rf`, and two workspaces never interfere with each other. Homebrew made the same trade 15 years ago; it's one of the reasons `brew install` and `brew uninstall` feel so reliable.
