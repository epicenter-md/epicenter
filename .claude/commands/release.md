---
description: Analyze changes and create a new version release
---

# Create a New Release

You are tasked with helping create a new version release of the application.

## Process

### 1. Analyze Changes Since Last Release

First, identify what has changed:

```bash
# Get the latest tag
LATEST_TAG=$(git tag --sort=-version:refname | head -1)
echo "Latest tag: $LATEST_TAG"

# Show commits since last tag
git log $LATEST_TAG..HEAD --oneline

# Get PRs merged since last release (more useful for release notes)
gh pr list --state merged --base main --limit 100 --json number,title,author,mergedAt | jq -r '.[] | select(.mergedAt > "RELEASE_DATE") | "* \(.title) by @\(.author.login) in https://github.com/EpicenterHQ/epicenter/pull/\(.number)"'
```

### 2. Categorize the Changes

Review all commits and PRs, categorizing them:

**User-facing (highlight these):**
- Features (feat): New functionality users can use
- Fixes (fix): Bugs that were annoying users
- Performance (perf): Speed improvements users will feel

**Internal (mention briefly if significant):**
- Refactoring, migrations, infrastructure changes
- Only include if they're foundational (e.g., "Zod to Arktype migration")

**Skip entirely:**
- Docs, chores, CI changes (unless user-relevant)

### 3. Determine Version Bump

Based on semantic versioning:

- **MAJOR (X.0.0):** Breaking changes that require user migration
- **MINOR (X.Y.0):** New features, backward compatible
- **PATCH (X.Y.Z):** Bug fixes only

Present your recommendation with reasoning.

### 4. Execute the Version Bump

Once confirmed, run from the repository root:

```bash
cd /Users/braden/Code/whispering
git checkout main
git pull origin main
bun run scripts/bump-version.ts [VERSION]
```

### 5. Draft Release Notes

Generate TWO versions of release notes:

#### GitHub Release Notes

Follow this structure:

```markdown
# Whispering vX.Y.Z: [Catchy 2-4 Word Summary]

[1-2 sentence narrative intro explaining the headline features. Frame it as what users can now DO, not what we changed.]

## [Feature Name]

[2-3 sentences explaining the feature. What is it, why it matters, how to use it.]

[Settings path or usage instructions if relevant]

## [Another Feature or Fix Category]

[Same pattern - explain, don't just list]

## Internal: [Significant Internal Change]

[Brief explanation of why this matters for the project's future, even if users don't see it directly]

## What's Changed

### Features
* feat: description by @author in https://github.com/EpicenterHQ/epicenter/pull/XXX

### Bug Fixes
* fix: description by @author in https://github.com/EpicenterHQ/epicenter/pull/XXX

### Performance
* perf: description by @author in https://github.com/EpicenterHQ/epicenter/pull/XXX

### Internal
* refactor/chore: description by @author in https://github.com/EpicenterHQ/epicenter/pull/XXX

## New Contributors
* @username made their first contribution in https://github.com/EpicenterHQ/epicenter/pull/XXX

**Full Changelog**: https://github.com/EpicenterHQ/epicenter/compare/vOLD...vNEW

---

**Questions?** Join our [Discord](https://go.epicenter.so/discord) or check the [README](https://github.com/EpicenterHQ/epicenter/tree/main/apps/whispering#readme).

**Love Whispering?** [Star us on GitHub](https://github.com/EpicenterHQ/epicenter) to show your support!
```

#### Discord Announcement

Shorter but not sparse. Convey the breadth of work:

```
**Whispering vX.Y.Z is out!**

[Headline feature in 1-2 sentences - what you can now do]

[Second feature or major fix]

[Third thing if significant]

Also in this release:
- [Quick bullet for smaller fix]
- [Another quick bullet]
- [Performance note if relevant]

[Acknowledge contributors if there are new ones or significant external PRs]

Full release notes: [link]
```

## Voice Guidelines

**DO:**
- Lead with what users can DO, not what we changed
- Use "you can now..." framing
- Explain WHY features matter
- Credit contributors with @mentions
- Include PR numbers and links
- Acknowledge the breadth of work without overwhelming

**DON'T:**
- Write generic bullet lists without context
- Use marketing language ("game-changing", "revolutionary")
- Skip the narrative intro
- Forget to include the PR list with authors
- Make Discord announcement too sparse OR too long

## Important Notes

- The bump script MUST run from main repo root, not Conductor workspace
- Script uses `git add -A` - check for untracked files first
- CI will trigger release builds when tag is pushed

## Rollback

```bash
git tag -d v[VERSION]
git push origin :refs/tags/v[VERSION]
git revert HEAD
git push origin main
```
