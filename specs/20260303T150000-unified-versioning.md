# Unified Versioning

## Status: Waves 1-2 Implemented, Wave 3 In Progress (auto.release.yml created)

## Problem

Versioning is fragmented. Only `apps/whispering` has a real version (`7.11.0`), synced across 5 hardcoded files. Every other package sits at placeholder `0.0.1`. Releases are manual (`bun run bump-version X.Y.Z`), which creates friction and means versions drift when someone forgets to bump.

## Goal

One version number across the entire monorepo. Every PR merge to `main` automatically produces a release. The version lives in git tags as the source of truth, and gets stamped into all files at release time.

## Version Scheme

```
8.Y.Z
│ │ └─ Patch: every merged PR (default)
│ └── Minor: PR title contains `!` (e.g., `feat!: breaking change`)
└─── Major: manual only, effectively permanent at 8
```

Version `8.0.0` is the inaugural release under this system. Major `9` is reserved for "if ever needed". The expectation is to stay on `8` indefinitely, similar to how Chrome version numbers just keep incrementing the minor/patch.

## Design Decisions

### Source of truth: git tags, not files

Files contain stale versions between releases. The git tag `v8.0.42` is the canonical current version. The `bump-version.ts` script reads from tags and stamps into files: files are derived, tags are authoritative.

This is the same approach OpenCode uses (they read from the npm registry, but the principle is the same: an external source of truth, not a checked-in file).

### Post-merge release, not in-PR version bump

**Chosen: Post-merge workflow commits version bump to `main` after PR merges.**

Alternative considered: bump version inside the PR before merge, so the merge commit itself contains the new version.

The in-PR approach has a fatal concurrency problem: if PR #1 and PR #2 are both open, they'd both compute the same next version (e.g., `8.0.1`). Whoever merges second creates a conflict or a duplicate. You'd need to constantly rebase PRs against each other's version bumps.

Post-merge avoids this entirely. A concurrency group ensures only one release workflow runs at a time, and each invocation reads the *latest* tag to determine the next version. The tradeoff is a "bot commit" on `main` after each PR: acceptable noise that OpenCode also produces (`release: v{version}` commits).

### Per-app workflows, not monolithic

Each app gets its own release and preview workflow:

- `release.whispering.yml`: builds Whispering desktop for 4 platforms on `v*` tags
- `release.epicenter.yml`: builds Epicenter desktop (when ready) on `v*` tags
- `pr-preview.whispering.yml`: builds Whispering preview artifacts on PRs touching relevant paths
- `pr-preview.epicenter.yml`: builds Epicenter preview artifacts (when ready)

Rationale:
- **Path filtering**: Only build the app whose code changed. A PR touching `apps/whispering/` shouldn't trigger an Epicenter build.
- **Independent failure**: One app's build failure doesn't block the other's release.
- **Clarity**: `release.whispering.yml` is immediately obvious; `publish-tauri-releases.yml` requires reading the file to know what it builds.
- **This is GitHub Actions best practice** for monorepos. Monolithic workflows become unmaintainable as apps multiply. Composite actions or reusable workflows handle shared setup steps (Rust toolchain, Bun, signing secrets).

### Workflow naming convention

GitHub Actions requires all workflows to be flat files in `.github/workflows/`: no subdirectories. We use a **period-delimited prefix convention** so workflows group naturally when sorted alphabetically. Periods are structural delimiters (separating category from name); hyphens are word separators within a segment.

| Prefix | Purpose | Examples |
|---|---|---|
| `release.{app}.yml` | Tag-triggered build + publish | `release.whispering.yml`, `release.epicenter.yml` |
| `pr-preview.{app}.yml` | PR preview artifacts | `pr-preview.whispering.yml`, `pr-preview.epicenter.yml` |
| `deploy.{target}.yml` | Deployment | `deploy.cloudflare.yml`, `deploy.cloudflare-preview.yml` |
| `ci.{name}.yml` | Linting, formatting, checks | `ci.autofix.yml`, `ci.format.yml` |
| `auto.{name}.yml` | Automated repo maintenance | `auto.release.yml`, `auto.label-issues.yml` |
| `meta.{name}.yml` | Repo meta tasks | `meta.sponsors-readme.yml`, `meta.update-readme-version.yml`, `meta.sync-releases.yml` |

Unprefixed: `claude.yml` (stays as-is. It's a one-off).

### `bump-version.ts` stays runnable manually

The script remains a CLI tool (`bun run bump-version 8.0.0`) for:
- The initial v8.0.0 release
- Emergency manual releases
- Local testing

But day-to-day, it's called by CI only. The script is refactored to be a pure "stamp version into files" utility, no `git commit`, no `git push`. CI handles the git operations.

## Architecture

### Release flow

```
PR merges to main
  → auto.release.yml fires (concurrency: 1)
  → reads latest v* git tag (e.g., v8.0.2)
  → parses PR title: has `!` → minor bump, else → patch bump
  → computes next version (e.g., 8.0.3)
  → runs: bun run bump-version 8.0.3
  → commits: "release: v8.0.3"
  → tags: v8.0.3
  → pushes commit + tag
  → release.whispering.yml triggers on v* tag
  → builds 4 platforms, creates draft GitHub release
  → (future) release.epicenter.yml triggers on same tag
```

### Files stamped by `bump-version.ts`

The script globs for app-level files that need version updates. Packages are **intentionally excluded**: they use independent semver for future npm publishing.

```
# JSON files (version field)
package.json                                    (root)
apps/*/package.json                             (all apps)

# Tauri configs (version field)
apps/*/src-tauri/tauri.conf.json                (all Tauri apps)

# Cargo.toml (version = "X.Y.Z")
apps/*/src-tauri/Cargo.toml                     (all Tauri apps)

# TypeScript constant
packages/constants/src/versions.ts              (single VERSION export)
```

**Why packages are excluded:** Internal dependencies use `workspace:*` protocol, so package version numbers are irrelevant for monorepo resolution. They only matter when publishing to npm, where each package needs a clean independent version history (starting from `1.0.0`, not jumping from `0.0.1` to `8.0.0`). Packages are versioned manually at publish time.

### `packages/constants/src/versions.ts` simplification

Before:
```ts
export const VERSIONS = {
  whispering: '7.11.0',
  cli: '1.0.0',      // unused stub
  api: '1.0.0',      // unused stub
} as const;
```

After:
```ts
/** Monorepo-wide version, stamped by CI on each release. */
export const VERSION = '8.0.0';
```

Consumers update: `VERSIONS.whispering` → `VERSION`.

### `auto-release.yml` workflow

```yaml
name: Auto Release

on:
  pull_request:
    types: [closed]
    branches: [main]

concurrency:
  group: auto-release
  cancel-in-progress: false  # queue, don't cancel

jobs:
  release:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0  # need tags
          token: ${{ secrets.GH_ACTIONS_PAT }}  # push commits + tags

      - uses: oven-sh/setup-bun@v2

      - name: Get current version from latest tag
        id: current
        run: |
          TAG=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo 'v0.0.0')
          echo "version=${TAG#v}" >> "$GITHUB_OUTPUT"

      - name: Compute next version
        id: next
        run: |
          CURRENT="${{ steps.current.outputs.version }}"
          IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

          TITLE="${{ github.event.pull_request.title }}"
          if echo "$TITLE" | grep -q '!'; then
            # Minor bump for breaking changes
            echo "version=${MAJOR}.$((MINOR + 1)).0" >> "$GITHUB_OUTPUT"
          else
            # Patch bump (default)
            echo "version=${MAJOR}.${MINOR}.$((PATCH + 1))" >> "$GITHUB_OUTPUT"
          fi

      - name: Stamp version into all files
        run: bun run bump-version ${{ steps.next.outputs.version }}

      - name: Commit, tag, push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -A
          git commit -m "release: v${{ steps.next.outputs.version }}"
          git tag "v${{ steps.next.outputs.version }}"
          git push
          git push origin "v${{ steps.next.outputs.version }}"
```

### Workflow renames

| Current | New | Trigger |
|---|---|---|
| `publish-tauri-releases.yml` | `release.whispering.yml` | `v*` tags |
| `pr-preview-builds.yml` | `pr-preview.whispering.yml` | PRs touching `apps/whispering/**`, `packages/**` |
| `preview-deployment.yml` | `deploy.cloudflare-preview.yml` | PRs (Cloudflare preview) |
| `autofix.yml` | `ci.autofix.yml` | PRs |
| `format.yml` | `ci.format.yml` | PRs |
| `auto-label-issues.yml` | `auto.label-issues.yml` | Issues |
| `add-sponsors-to-readme.yml` | `meta.sponsors-readme.yml` | Scheduled |
| `update-readme-version.yml` | `meta.update-readme-version.yml` | Release events |
| `sync-releases-epicenter-to-whispering.yml` | `meta.sync-releases.yml` | Release events |
| `cleanup-preview.yml` | `deploy.cleanup-preview.yml` | PR close |
| (new, Wave 3) | `auto.release.yml` | PR merged to `main` |
| (future) | `release.epicenter.yml` | `v*` tags |
| (future) | `pr-preview.epicenter.yml` | PRs touching `apps/epicenter/**`, `packages/**` |

Unchanged: `claude.yml`, `deploy.cloudflare.yml`.

## Migration Steps

**Waves 1-2 are safe to ship immediately.** They are pure infrastructure: no version bump, no release. The repo has 185 existing `v*` tags (latest `v7.11.0`), so `auto-release.yml` must NOT exist until Wave 3 or it would increment from `v7.11.0` on the next PR merge.

### Wave 1: Version infrastructure
1. Refactor `bump-version.ts` to glob all packages, remove git operations
2. Simplify `packages/constants/src/versions.ts` to single `VERSION` export
3. Update `apps/landing/src/components/whispering/OSDetector.svelte` import

### Wave 2: Workflow renames
4. Rename `publish-tauri-releases.yml` → `release.whispering.yml`
5. Rename `pr-preview-builds.yml` → `pr-preview.whispering.yml`, add path filters
6. Rename `preview-deployment.yml` → `deploy.cloudflare-preview.yml`
7. Rename `cleanup-preview.yml` → `deploy.cleanup-preview.yml`
8. Rename `autofix.yml` → `ci.autofix.yml`
9. Rename `format.yml` → `ci.format.yml`
10. Rename `add-sponsors-to-readme.yml` → `meta.sponsors-readme.yml`
11. Rename `update-readme-version.yml` → `meta.update-readme-version.yml`
12. Rename `sync-releases-epicenter-to-whispering.yml` → `meta.sync-releases.yml`
13. Rename `deploy-cloudflare.yml` → `deploy.cloudflare.yml`
14. Rename `auto-label-issues.yml` → `auto.label-issues.yml`

### Wave 3: Initial release (when ready)

Wave 3 is intentionally decoupled. Tag `v8.0.0` when the big release is ready: could be days or weeks after Waves 1-2 land.

15. Create `auto.release.yml`
16. Run `bun run bump-version 8.0.0` manually to stamp all files
17. Commit, tag `v8.0.0`, push: triggers first release under new system
18. Verify `release.whispering.yml` builds successfully
19. Verify `auto.release.yml` fires on next PR merge

## References

- [sst/opencode](https://github.com/sst/opencode): single version across monorepo, post-merge `release: v{version}` commits, manual `./script/release [patch|minor]` trigger
- OpenCode's `packages/script/src/index.ts`: version computation logic
- OpenCode's `publish.yml`: stamps version into all package.json via glob at publish time
