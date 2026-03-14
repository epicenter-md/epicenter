---
name: git
description: Git commit and pull request guidelines using conventional commits. Use when creating commits, writing commit messages, creating PRs, or reviewing PR descriptions.
---

# Git Commit and Pull Request Guidelines

## Conventional Commits Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Commit Types

- `feat`: New features (correlates with MINOR in semantic versioning)
- `fix`: Bug fixes (correlates with PATCH in semantic versioning)
- `docs`: Documentation only changes
- `refactor`: Code changes that neither fix bugs nor add features
- `perf`: Performance improvements
- `test`: Adding or modifying tests
- `chore`: Maintenance tasks, dependency updates, etc.
- `style`: Code style changes (formatting, missing semicolons, etc.)
- `build`: Changes to build system or dependencies
- `ci`: Changes to CI configuration files and scripts

### Scope Guidelines

- **Scope is OPTIONAL**: only add when it provides clarity
- Use lowercase, placed in parentheses after type: `feat(transcription):`
- Prefer specific component/module names over generic terms
- Your current practice is good: component names (`EditRecordingDialog`), feature areas (`transcription`, `sound`)
- Avoid overly generic scopes like `ui` or `backend` unless truly appropriate

### When to Use Scope

- When the change is localized to a specific component/module
- When it helps distinguish between similar changes
- When working in a large codebase with distinct areas

### When NOT to Use Scope

- When the change affects multiple areas equally
- When the type alone is sufficiently descriptive
- For small, obvious changes

### Description Rules

- Start with lowercase immediately after the colon and space
- Use imperative mood ("add" not "added" or "adds")
- No period at the end
- Keep under 50-72 characters on first line

### Breaking Changes & Version Bumps

Our monorepo uses a unified version scheme (`8.Y.Z`) where major version 8 is permanent:

- **Patch** (default): Every merged PR increments `Z` (e.g., `8.0.1` → `8.0.2`)
- **Minor**: Add `!` after type/scope: `feat(api)!: change endpoint structure` — increments `Y`, resets `Z`
- **Major**: Manual only. Reserved for "if ever needed." Do not use `!` expecting a major bump.

Include `BREAKING CHANGE:` in the commit footer with details when using `!`.

### Examples Following Your Style:

- `feat(transcription): add model selection for OpenAI providers`
- `fix(sound): resolve audio import paths in assets module`
- `refactor(EditRecordingDialog): implement working copy pattern`
- `docs(README): clarify cost comparison section`
- `chore: update dependencies to latest versions`
- `fix!: change default transcription API endpoint`

## Commit Messages Best Practices

### The "Why" is More Important Than the "What"

The commit message subject line describes WHAT changed. The commit body explains WHY.

**Good commit** (explains motivation):

```
fix(auth): prevent session timeout during file upload

Users were getting logged out mid-upload on large files because the
session refresh only triggered on navigation, not background activity.
```

**Bad commit** (only describes what):

```
fix(auth): add keepalive call to upload handler
```

The first commit tells future developers WHY the code exists. The second makes them dig through the code to understand the purpose.

### Other Best Practices

- NEVER include Claude Code or opencode watermarks or attribution
- Each commit should represent a single, atomic change
- Write commits for future developers (including yourself)
- If you need more than one line to describe what you did, consider splitting the commit

### Changelog Entries in PRs

PRs with `feat:` or `fix:` prefix MUST include a `## Changelog` section in the PR description body. These entries are automatically aggregated into GitHub Releases by `auto.release.yml`.

**Rules:**

- One line per user-visible change
- Written for end users, not developers — describe the benefit, not the implementation
- Use imperative mood ("Add...", "Fix...", not "Added" or "Fixes")
- Internal-only PRs (`chore:`, `refactor:`, `docs:`) should omit the section entirely

**Good entries:**

```
## Changelog
- Add local workspace sync via Bun sidecar
- Fix sync client sending unnecessary heartbeat probes
```

**Bad entries:**

```
## Changelog
- refactor(services): flatten isomorphic/ to services root
- Bump transcribe-rs 0.2.1 → 0.2.9
```

The first examples describe user-visible outcomes. The second examples are developer shorthand that means nothing to users.

## Pull Request Guidelines

### WHAT First, Then WHY

Every PR description MUST open with a crisp one-sentence summary of WHAT changed, then immediately explain WHY. The WHAT grounds the reader; the WHY gives them the motivation.

**Good PR opening**:

> Redesigns the `createTaggedError` builder: flat `.withFields()` API replaces nested `.withContext()`/`.withCause()`, `.withMessage()` is optional and seals the message.
>
> Analysis of 321 error call sites revealed every error is always all-or-nothing on message ownership. The old API allowed overriding `.withMessage()` at the call site, which masked design problems rather than solving them.

**Bad opening** (why without what):

> Users were getting logged out mid-upload on large files. The session refresh only triggered on navigation, not during background activity like uploads.

**Bad opening** (what without why):

> This PR adds a keepalive call to the upload handler and updates the session refresh logic.

The reader should understand WHAT changed before they understand WHY — but they need both.

### Code Examples Are Mandatory for API Changes

If the PR introduces or modifies APIs, you MUST include code examples showing how to use them. No exceptions.

**What requires code examples:**

- New functions, types, or exports
- Changes to function signatures
- New CLI commands or flags
- New HTTP endpoints
- Configuration changes

**Good API PR** (shows the actual usage):

```typescript
// Define actions once
const actions = {
	posts: {
		create: defineMutation({
			input: type({ title: 'string' }),
			handler: ({ title }) => client.tables.posts.create({ title }),
		}),
	},
};

// Pass to adapters - they generate CLI commands and HTTP routes
const cli = createCLI(client, { actions });
const server = createServer(client, { actions });
```

**Bad API PR** (only describes without showing):

> This PR adds an action system that generates CLI commands and HTTP routes from action definitions.

The first version lets reviewers understand the API at a glance. The second forces them to dig through the code to understand the call sites.

### Before/After Code Snippets for Refactors

Code examples aren't just for API changes. For internal refactors that change how code is structured without changing the public API, before/after code snippets show reviewers the improvement concretely:

```typescript
// BEFORE: direct YKeyValueLww usage with manual scanning
const ykv = new YKeyValueLww<unknown>(yarray);

function reconstructRow(rowId) {           // O(n) - scan every cell
  for (const [key, entry] of ykv.map) {
    if (key.startsWith(prefix)) { ... }
  }
}

// AFTER: composed storage layers
const cellStore = createCellStore<unknown>(ydoc, TableKey(tableId));
const rowStore = createRowStore(cellStore);

rowStore.has(id)           // O(1)
rowStore.get(id)           // O(m) where m = fields per row
rowStore.count()           // O(1)
```

Use before/after snippets when:

- Internal implementation changes significantly even though external API is unchanged
- Performance characteristics change and the code shows why
- Complexity is being moved/decomposed (show what was inlined vs what's now delegated)

### Diagrams

Use ASCII diagrams for architecture, data flow, before/after comparisons, and evolution across PRs. They're more scannable than prose. Alternate prose and visuals—never let either run for more than a short paragraph.

Box-drawing characters: `┌ ┐ └ ┘ ─ │ ├ ┤ ┬ ┴ ┼ ▼ ▲ ──→ ←──`

Use composition trees (`└──`, `├──`) for showing module decomposition. Use file relocation trees when directory moves ARE the architectural statement (not when files just happen to move).

### Other Guidelines

- NEVER include Claude Code or opencode watermarks or attribution in PR titles/descriptions
- PR title should follow same conventional commit format as commits
- Focus on the "why" and "what" of changes, not the "how it was created"
- Include any breaking changes prominently
- Link to relevant issues

### Scanning GitHub Issues Before Writing a PR Description

Before drafting, search open issues for related work:

```bash
gh issue list --state open --limit 100 --json number,title,labels
gh issue view <NUMBER> --json title,body,labels,comments
```

Reference honestly: `Closes #123` (fully resolves), `Partially addresses #123` (improves), `Lays groundwork for #123` (prerequisite only). Don't claim a fix unless changes directly address the root cause.

### Verifying GitHub Usernames

NEVER guess `@username` mentions. Verify with `gh pr view <NUMBER> --json author` or `gh issue view <NUMBER> --json author`.

### Merge Strategy

When merging PRs, use regular merge commits (NOT squash):

```bash
gh pr merge --merge  # Correct: preserves commit history
# NOT: gh pr merge --squash
# NOT: gh pr merge --rebase

# Use --admin flag if needed to bypass branch protections
gh pr merge --merge --admin
```

Preserve individual commits; they tell the story of how the work evolved.

### Pull Request Body Format

#### Simple PRs (single-purpose changes)

Use clean paragraph format:

**First Paragraph**: Explain what the change does and what problem it solves.

**Subsequent Paragraphs**: Explain how the implementation works.

**Example**:

```
This change enables proper vertical scrolling for drawer components when content exceeds the available drawer height. Previously, drawers with long content could overflow without proper scrolling behavior, making it difficult for users to access all content and resulting in poor mobile UX.

To accomplish this, I wrapped the `{@render children?.()}` in a `<div class="flex-1 overflow-y-auto">` container. The `flex-1` class ensures the content area takes up all remaining space after the fixed drag handle at the top, while `overflow-y-auto` enables vertical scrolling when the content height exceeds the available space.
```

#### Architectural PRs (API changes, structural refactors)

Open with WHAT+WHY. Show before/after code for API changes. Use diagrams for structural changes. Add a `### Why X?` section for each non-obvious design decision. Mention what's intentionally deferred.

Use judgment about which of these the reviewer actually needs—not every PR needs every section. Lead with code and diagrams; prose explains the visuals.

Use architectural format for: public API changes, persistent data format changes, cross-package contracts, new subsystems. Use simple format for everything else.

### Definition of Done (PR Description)

A PR description is complete when:

- Opens with WHAT changed (one sentence), then WHY
- API changes include before/after code examples
- No file listings, no AI attribution, no `## Summary` headers
- `## Changelog` section present for `feat:`/`fix:` PRs (omit for `chore:`/`refactor:`/`docs:`)

#### Voice and Tone

- **Conversational but precise**: Write like explaining to a colleague
- **Direct and honest**: "This has been painful" rather than "This presented challenges"
- **Show your thinking**: "We considered X, but Y made more sense because..."
- **Use "we" for team decisions, "I" for personal observations**

#### Example PR Description:

````
This fixes the long-standing issue with nested reactivity in state management.

First, some context: users have consistently found it cumbersome to create deeply reactive state. The current approach requires manual get/set properties, which doesn't feel sufficiently Svelte-like. Meanwhile, we want to move away from object mutation for future performance optimizations, but `obj = { ...obj, x: obj.x + 1 }` is ugly and creates overhead.

This PR introduces proxy-based reactivity that lets you write idiomatic JavaScript:

```javascript
let todos = $state([]);
todos.push({ done: false, text: 'Learn Svelte' }); // just works
```

Under the hood, we're using Proxies to lazily create signals as necessary. This gives us the ergonomics of mutation with the performance benefits of immutability.

Still TODO:
- Performance optimizations for large arrays
- Documentation updates
- Migration guide for existing codebases

This doubles down on Svelte's philosophy of writing less, more intuitive code while setting us up for the fine-grained reactivity improvements planned for v6.
````

#### What to Avoid

- **Listing files changed**: Never enumerate which files were modified. GitHub's "Files changed" tab already shows this; the PR description should explain WHY, not WHAT files
- **"Changes" sections at the top**: If you need a changes summary, put it at the very end and keep it minimal. Most PRs don't need one.
- **Test plans**: Skip unless specifically requested. Tests should be in the code, not described in prose.
- **Section headers like "## Summary" or "## Changes Made"**
- Bullet points or structured lists as a substitute for explanatory prose (bullets for the change list are fine)
- Marketing language or excessive formatting
- Corporate language: "This PR enhances our solution by leveraging..."
- Marketing speak: "game-changing", "revolutionary", "seamless"
- Clichés like "first principles"
- Dramatic hyperbole: "feels like an eternity", "pain point", "excruciating" — stick to facts ("saves 150ms") not drama
- Over-explaining simple changes
- Apologetic tone for reasonable decisions

## What NOT to Include:

- `Generated with [Claude Code](https://claude.ai/code)`
- `Co-Authored-By: Claude <noreply@anthropic.com>`
- Any references to AI assistance
- `Generated with [opencode](https://opencode.ai)`
- `Co-Authored-By: opencode <noreply@opencode.ai>`
- Tool attribution or watermarks
