# Changelog & Release Notes Strategy

**Date**: 2026-03-11
**Status**: Draft
**Author**: AI-assisted
**Depends on**: `specs/20260303T150000-unified-versioning.md` (Wave 3)

## Overview

Define how changelog entries are authored, collected, and published across the Epicenter monorepo. Starting with GitHub Releases at v8 launch, with a path toward a website `/changelog` endpoint.

## Motivation

### Current State

No changelog exists. Releases are manual (`bun run bump-version X.Y.Z`). The unified versioning spec (Wave 3) defines `auto.release.yml` for automatic version bumping on PR merge, but says nothing about *what goes into the release body*.

PR titles follow conventional commits:
```
feat(sync): enrich SyncStatus with discriminated union
fix(transcription): bump transcribe-rs 0.2.1 → 0.2.9
refactor(services): flatten isomorphic/ to services root
chore(deps): standardize yjs versions to catalog
```

These are useful for developers but opaque to users.

### Problems

1. **No release history**: Users and contributors have no way to see what changed between versions
2. **No changelog discipline**: When v8 ships, there will be hundreds of changes with no structured record
3. **PR titles are developer-facing**: `refactor(services): flatten isomorphic/ to services root` means nothing to a user
4. **Batch generation fails**: Research into OpenCode's approach shows AI-generated changelogs produce embarrassing artifacts when done at release time (see Research Findings)

### Desired State

- Every user-visible PR includes a one-line changelog entry written by the author
- `auto.release.yml` collects these entries and publishes a grouped GitHub Release
- Internal changes (`chore:`, `refactor:`) are released but excluded from the public changelog
- A future `/changelog` website page pulls from the same source

## Research Findings

### OpenCode's Release Process

Studied [opencode.ai/changelog](https://opencode.ai/changelog) and [GitHub releases](https://github.com/anomalyco/opencode/releases/tag/v1.2.24).

| Dimension | OpenCode | Notes |
|---|---|---|
| Cadence | ~daily, sometimes 2x/day | v1.2.20. V1.2.24 shipped in 4 days |
| Format | Bullet points grouped by component (Core, TUI, Desktop, SDK) | Short one-liners |
| Generation | AI-generated at release time by `opencode-agent` GitHub App | Batch processes commit diffs |
| Per-PR entries | No. Batch generated from commits | Authors don't write entries |
| Quality | Low. AI hallucinations leak into production | See artifacts below |
| Community credits | `(@contributor)` links inline | Nice touch |
| Website | `/changelog` page mirrors GitHub Releases | Same content, different presentation |

**Quality artifacts found in production releases:**

- v1.2.21: *"I need to see the actual commit diff to understand what was fixed and provide an accurate changelog entry."*: raw LLM chain-of-thought
- v1.2.21: *"Based on the commit message 'fix(app): all panels transition', here's the changelog entry:"*: LLM reasoning leaked

**Key finding**: Batch AI generation at release time produces inconsistent, sometimes embarrassing results. The person who wrote the code is always better positioned to describe what it does.

**Implication**: Shift changelog authoring left to PR time. Each author writes their own entry. The release workflow merely aggregates.

### Alternative Approaches Considered

| Tool/Approach | How it works | Tradeoff |
|---|---|---|
| [Changesets](https://github.com/changesets/changesets) | Separate `.changeset/*.md` files per PR | Extra file per PR, extra tooling, designed for multi-package publishing. Overkill for our monorepo |
| Conventional changelog | Auto-generate from commit messages | Same problem as OpenCode. Developer-facing, not user-facing |
| PR description section | Author writes one-line entry in PR body | Zero tooling, lives where reviewers already look, easy to enforce |
| GitHub Release auto-generate | GitHub's built-in "Generate release notes" | Lists PR titles verbatim. Not user-friendly |

**Key finding**: PR description sections hit the best tradeoff. Zero new tooling, reviewed alongside code, human-written quality.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where entries are authored | PR description `## Changelog` section | Zero tooling, reviewed with code, author writes the "why" |
| Entry format | One line per user-visible change | Keeps entries scannable, matches OpenCode's readable style without the AI slop |
| Internal change handling | Omit `## Changelog` section entirely | No noise in releases-`chore:` and `refactor:` still get version bumps but no changelog entry |
| Grouping in releases | By conventional commit prefix (feat → New, fix → Fixed) | Already using conventional commits in PR titles |
| AI involvement | None for generation; optional human-triggered polish | Avoids OpenCode's quality problems |
| Release body target | GitHub Releases (source of truth) | Already where users look; website pulls from this later |
| Website `/changelog` | Deferred to post-v8 | Build what's needed now; website can consume GitHub Releases API when ready |
| Versioning scope | Apps only (8.Y.Z); packages excluded | Packages use independent semver for future npm publishing. `workspace:*` makes internal version numbers irrelevant. |

## Architecture

### PR Authoring Flow

```
PR Author writes:

  ## Changelog
  <!-- One line per user-visible change. Omit section for internal-only changes. -->
  - Add Bun sidecar for local workspace sync
```

### Release Aggregation Flow

```
PR merges to main
  → auto.release.yml fires (concurrency: 1)
  → reads latest v* tag
  → computes next version (patch or minor)
  → collects all merged PRs since last tag
  → extracts ## Changelog section from each PR description
  → groups entries:
      feat:  → "New"
      fix:   → "Fixed"
      other: → "Improved" (only if ## Changelog section exists)
  → PRs without ## Changelog section → excluded from body
  → stamps version into files (bump-version.ts)
  → commits "release: v{version}"
  → tags v{version}
  → creates GitHub Release with grouped changelog body
```

### GitHub Release Output Format

```markdown
## New

- Add Bun sidecar for local workspace sync (#1494)
- Enrich SyncStatus with discriminated union and SQLite persistence (#1486)

## Fixed

- Fix sync client sending unnecessary heartbeat probes (#1478)
- Fix expandedWindows timing and a11y nesting in tab manager (#1493)

## Improved

- Standardize trash icon to trash-2 across the app (#1484)

**Full diff**: v8.0.1...v8.0.2
```

### Future: Website `/changelog` Endpoint

```
/changelog page (post-v8)
  → fetches GitHub Releases API: GET /repos/EpicenterHQ/epicenter/releases
  → renders each release as a card (date, version, grouped entries)
  → static generation at build time (or ISR)
  → same content as GitHub Releases, different presentation
```

## Implementation Plan

### Phase 1: PR Template & Convention

- [x] **1.1** Add `## Changelog` section to PR template (`.github/pull_request_template.md`)
- [x] **1.2** Document the convention in `CONTRIBUTING.md`
- [x] **1.3** Add HTML comment guide: `<!-- One line per user-visible change. Omit section for internal-only changes. -->`

### Phase 2: Release Workflow (`auto.release.yml`)

This extends Wave 3 of the unified versioning spec.

- [x] **2.1** Create `auto.release.yml` per unified versioning spec
- [x] **2.2** Add step: collect merged PRs since last tag via merge commit log + `gh pr view`
- [x] **2.3** Add step: extract `## Changelog` sections from PR bodies, parse entries
- [x] **2.4** Add step: group entries by PR title prefix (`feat:` → New, `fix:` → Fixed, other → Improved)
- [x] **2.5** Add step: generate release body markdown
- [x] **2.6** Add step: create GitHub Release via `gh release create v{version} --title "v{version}" --notes-file`
- [ ] **2.7** Test with a dry-run PR to verify extraction and grouping

### Phase 3: Website `/changelog` (Post-v8, Deferred)

- [ ] **3.1** Add `/changelog` route to landing site (`apps/landing`)
- [ ] **3.2** Fetch releases from GitHub API at build time
- [ ] **3.3** Render as chronological list with version, date, and grouped entries
- [ ] **3.4** Consider RSS feed generation from the same data

## Edge Cases

### PR with no `## Changelog` section

1. Author submits a `chore:` or `refactor:` PR without the section
2. Release workflow finds no entries for this PR
3. PR is still released (gets a version bump) but excluded from the changelog body
4. Expected: silent omission, no error

### PR with multiple changelog entries

1. Author writes multiple lines under `## Changelog`
2. All lines are included, each as a separate bullet
3. Grouped under the PR title's conventional commit prefix

### First release (v8.0.0)

1. No previous tag to diff against (or many tags from v7.x)
2. `auto.release.yml` should use a manually specified baseline tag or date
3. v8.0.0 release notes should be hand-written (major release, marketing moment)
4. `auto.release.yml` takes over from v8.0.1 onward

### PR squash-merged with modified title

1. Author writes `## Changelog` in the PR description
2. PR is squash-merged, reviewer edits the title
3. Grouping uses the *merge commit title*, not the original PR title
4. This is correct behavior. Reviewer has final say on categorization

## Resolved Questions

1. **Enforce `## Changelog` on `feat:` and `fix:` PRs?**
   → **Warn-only CI check.** No blocking. Avoids friction during fast iteration. Upgrade to blocking after the habit develops.

2. **v8.0.0 release notes auto-generated or hand-written?**
   → **Hand-written narrative.** v8.0.0 is a major milestone and marketing moment. Auto-generation starts at v8.0.1.

3. **Community contributor credits?**
   → **Yes.** Append `(@username)` to entries from external contributors. The `gh` API provides author info.

4. **Emoji prefixes in section headers?**
   → **Plain text.** `## New` / `## Fixed` / `## Improved`: no emojis.

## Success Criteria

- [ ] PR template includes `## Changelog` section with guidance comment
- [ ] `CONTRIBUTING.md` documents the changelog convention
- [ ] `auto.release.yml` creates GitHub Releases with grouped entries on PR merge
- [ ] Internal-only PRs (no `## Changelog`) are excluded from release body
- [ ] First automated release (v8.0.1) produces a clean, readable GitHub Release
- [ ] No AI hallucinations in any release notes

## References

- `specs/20260303T150000-unified-versioning.md`: Wave 3 defines `auto.release.yml` skeleton
- `specs/20250708T000000-v7-release-notes-improvement.md`: Prior art on user-friendly release notes
- `scripts/bump-version.ts`: Version stamping utility (already glob-based)
- `.github/workflows/`: Existing workflow naming convention (`auto.{name}.yml`)
- [OpenCode changelog](https://opencode.ai/changelog): Reference for format (not quality)
- [OpenCode v1.2.24 release](https://github.com/anomalyco/opencode/releases/tag/v1.2.24): Example of AI-generated release

## Review

### Changes Made

**Phase 1: PR Template & Convention**

- Added `## Changelog` section to `.github/pull_request_template.md` immediately after `## Summary`, with the HTML comment guide. All existing sections preserved.
- Added "Changelog Entries" subsection to `CONTRIBUTING.md` under the Development Workflow section (after step 5 about pushing). Includes good/bad examples and explains which PR types need entries.
- Added `### Changelog Entries in PRs` section to `.agents/skills/git/SKILL.md` in the PR Guidelines area, with rules, examples, and grouping explanation.

**Phase 2: Release Workflow**

- Created `.github/workflows/auto.release.yml` extending the unified versioning skeleton with changelog aggregation.
- PR collection uses `git log --merges` to find PR numbers from merge commits since the last tag (more reliable than date-based `gh pr list` search). Falls back to the triggering PR number as a guaranteed inclusion.
- Changelog extraction uses `awk` to parse `## Changelog` sections from PR bodies, `grep` to filter to bullet lines, and `sed` to strip bullet prefixes.
- Entries grouped into temp files by PR title prefix (`feat:` → New, `fix:` → Fixed, other → Improved).
- External contributor detection via `gh api orgs/EpicenterHQ/members/$AUTHOR`: appends `(@username)` for non-members.
- Release body falls back to "Internal improvements only." when no PRs have changelog sections.
- Breaking change detection tightened from `grep -q '!'` to `grep -qE '!:'` to avoid false positives on PR titles containing `!` in other contexts.

### Design Decisions

1. **Merge commit log over `gh pr list`**: The spec suggested `gh pr list --search "merged:>={date}"`, but GitHub search has day-level date precision which can miss same-day PRs or double-count them. Using `git log --merges` with the tag range is exact.
2. **`!:` instead of `!` for minor bump**: The original skeleton grepped for bare `!` anywhere in the title. Tightened to `!:` which matches the conventional commit breaking change marker and avoids false positives.
3. **`--notes-file` instead of inline `--notes`**: Release body is written to a temp file and passed via `--notes-file` to avoid shell quoting issues with markdown content.
