# How to Commit Changesets: A Practical Guide

## TL;DR
- **Small changes**: Commit code + changeset together
- **Large changes**: Separate commits for code, then changeset
- **Always** write changesets from the user's perspective
- Run `changeset version` only when ready to release

## What Are Changesets?

Changesets are **intent declarations** for your releases. They:
- Document what changed and why
- Determine version bumps (patch/minor/major)  
- Generate changelogs automatically
- Keep your release process predictable

**Key principle**: Changesets are about *releases*, git commits are about *development*.

## Commit Strategies

### Strategy 1: Single Commit (Recommended for Small Changes)

```bash
# Make your change
echo "declarationMap: true" >> tsconfig.json

# Create changeset
npx changeset add

# Commit everything together
git add .
git commit -m "chore: add declarationMap to tsconfig"
```

**When to use**: Bug fixes, small features, configuration changes

**Pros**: Clean history, atomic changes  
**Cons**: Less granular history

### Strategy 2: Separate Commits (Better for Large Changes)

```bash
# Make your changes
git add src/new-feature.ts src/types.ts
git commit -m "feat: add Result.mapAsync method"

# Document the change
npx changeset add
git add .changeset/
git commit -m "changeset: add Result.mapAsync feature"
```

**When to use**: Major features, breaking changes, complex refactors

**Pros**: Clear separation, easier code review  
**Cons**: More commits

### Strategy 3: Feature Branch Workflow

```bash
# On feature branch - make changes and add changeset
git checkout -b feature/async-support
# ... make changes ...
npx changeset add
git commit -m "feat: add async Result methods with changeset"

# On main branch - squash merge preserves the changeset
git checkout main
git merge --squash feature/async-support
git commit -m "feat: add async Result methods"
```

## When to Run Changeset Commands

### During Development
```bash
# Add changeset for each logical change
npx changeset add
```
- Run this **immediately** after making a user-facing change
- Don't batch multiple unrelated changes into one changeset

### Before Release
```bash
# Update versions and changelog
npx changeset version

# Publish to npm
npx changeset publish
```
- `changeset version` consumes all pending changesets
- Only run when you're ready to release
- This updates `package.json` and `CHANGELOG.md`

## Writing Great Changesets

### ❌ Bad Examples
```md
---
"my-package": patch
---

Fixed bug
```

```md
---
"my-package": minor  
---

Updated code
```

### ✅ Good Examples
```md
---
"my-package": patch
---

Fix memory leak in Result.map() when chaining operations
```

```md
---
"my-package": minor
---

Add Result.mapAsync() for handling asynchronous transformations
```

### Writing Guidelines
1. **Be specific**: What exactly changed?
2. **User-focused**: How does this affect someone using your library?
3. **Action-oriented**: Use verbs (Add, Fix, Remove, Update)
4. **Context matters**: Include the affected method/feature

## Choosing Semver Levels

| Level | When to Use | Examples |
|-------|-------------|----------|
| `patch` | Bug fixes, internal improvements, docs | Fix null pointer, Update README |
| `minor` | New features, non-breaking additions | Add new method, New optional parameter |
| `major` | Breaking changes, removed features | Change method signature, Remove deprecated API |

## Common Workflow Patterns

### Pattern 1: Continuous Changesets
```bash
# Each PR includes its changeset
git checkout -b fix/validation-bug
# ... fix code ...
npx changeset add  # Document the fix
git commit -m "fix: handle empty validation cases"
```

### Pattern 2: Batch Changesets
```bash
# Make multiple changes first
git commit -m "refactor: extract validation logic" 
git commit -m "feat: add email validation"
git commit -m "fix: handle edge case in phone validation"

# Then document all changes
npx changeset add  # For the new feature (minor)
npx changeset add  # For the bug fix (patch)
# Skip changeset for refactor (internal change)
```

### Pattern 3: Release Preparation
```bash
# When ready to release
npx changeset version    # This updates package.json + CHANGELOG.md
git add .
git commit -m "chore: version packages"

npx changeset publish    # This publishes to npm
git push --follow-tags   # Push the version commit and tags
```

## Pro Tips

### 🎯 Do This
- Write changesets immediately after making changes
- Use conventional commit messages alongside changesets
- Review generated changelogs before publishing
- Keep changesets focused on one logical change

### 🚫 Avoid This
- Don't run `changeset version` during development
- Don't combine unrelated changes in one changeset
- Don't write changesets for internal/dev-only changes
- Don't forget to commit the `.changeset` folder

## Example: Real-World Workflow

```bash
# 1. Feature development
git checkout -b feature/retry-logic
echo "// Add retry logic" >> src/result.ts
npx changeset add  # Choose 'minor', describe the feature
git add .
git commit -m "feat: add retry logic with exponential backoff"

# 2. Bug discovered during development  
echo "// Fix edge case" >> src/result.ts
npx changeset add  # Choose 'patch', describe the fix
git add .
git commit -m "fix: handle retry timeout edge case"

# 3. Ready to release
git checkout main
git merge feature/retry-logic
npx changeset version  # Updates versions, consumes changesets
git add .
git commit -m "chore: release v1.2.0"
npx changeset publish  # Publishes to npm
```

---

**Remember**: Changesets are documentation for your future self and your users. Treat them as carefully as you would treat your README or API documentation. 