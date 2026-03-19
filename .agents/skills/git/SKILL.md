---
name: git
description: Git commit and pull request guidelines using conventional commits. Use when creating commits, writing commit messages, creating PRs, or reviewing PR descriptions.
metadata:
  author: epicenter
  version: '1.0'
---

# Git Commit and Pull Request Guidelines

> **Related Skills**: See `incremental-commits` for breaking multi-file changes into atomic commits.

## When to Apply This Skill

Use this pattern when you need to:

- Write commit messages that follow conventional commit rules.
- Decide commit type/scope formatting and breaking-change notation.
- Draft PR descriptions that open with WHAT then WHY.
- Add required user-facing changelog entries for `feat:`/`fix:` PRs.
- Review commit/PR text for anti-patterns like AI/tool attribution.

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

### Visual Communication with ASCII Art

Use ASCII diagrams liberally to communicate complex ideas. They're more scannable than prose and show relationships at a glance.

#### Journey/Evolution Diagrams

For PRs that iterate on previous work, show the evolution:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  PR #1217 (Jan 7)                                                       │
│  "Add YKeyValue for 1935x storage improvement"                          │
│                                                                         │
│       Y.Map (524,985 bytes) ──→ YKeyValue (271 bytes)                   │
│                                                                         │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  PR #1226 (Jan 8)                                                       │
│  "Remove YKeyValue, use native Y.Map + epoch compaction"                │
│                                                                         │
│  Reasoning: "Unpredictable LWW behavior"  ← ⚠️ (misleading!)            │
│                                                                         │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  This PR                                                                │
│  "Restore YKeyValue with LWW timestamps"                                │
│                                                                         │
│  Why: Timestamp-based resolution gives intuitive "latest wins"          │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Layered Architecture Diagrams

Show how components stack:

```
┌─────────────────────────────────────────────────────────────┐
│  defineWorkspace() + workspace.create()                     │  ← High-level
│    Creates Y.Doc internally, binds tables/kv/capabilities   │
├─────────────────────────────────────────────────────────────┤
│  createTables(ydoc, {...}) / createKv(ydoc, {...})          │  ← Mid-level
│    Binds to existing Y.Doc                                  │
├─────────────────────────────────────────────────────────────┤
│  defineTable() / defineKv()                                 │  ← Low-level
│    Pure schema definitions                                  │
└─────────────────────────────────────────────────────────────┘
```

#### Comparison Tables

For showing trade-offs between approaches:

```
┌────────────────────────────────────────────────────────────────┐
│  Use Case                         │  Recommendation            │
├───────────────────────────────────┼────────────────────────────┤
│  Real-time collab, simple cases   │  YKeyValue (positional)    │
│  Offline-first, multi-device      │  YKeyValueLww (timestamp)  │
│  Clock sync unreliable            │  YKeyValue (no clock dep)  │
└────────────────────────────────────────────────────────────────┘
```

#### Flow Diagrams

For showing data/control flow:

```
┌────────────────────────────────────────────────────────────────┐
│                     Conflict Resolution                        │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Client A (2:00pm)  ──┐                                        │
│                       │──→  Sync  ──→  Winner?                 │
│  Client B (3:00pm)  ──┘                                        │
│                                    │                           │
│                   ┌────────────────┴────────────────┐          │
│                   ▼                                 ▼          │
│             YKeyValue                         YKeyValueLww     │
│          (clientID wins)                   (timestamp wins)    │
│           ~50% correct                       100% correct      │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

#### Composition Tree Diagrams

For refactors that change how modules compose, use lightweight indented tree notation instead of heavy box-drawing. This shows the dependency/composition hierarchy at a glance:

**Before** — one module doing everything:

```
TableHelper (schema + CRUD + row reconstruction + observers)
  └── YKeyValueLww  ←  Map<"rowId:colId", entry>
        ├── reconstructRow()   O(n) scan all keys for prefix
        ├── collectRows()      O(n) group all cells by rowId
        └── deleteRowCells()   O(n) filter + delete
```

**After** — each layer has a single responsibility:

```
TableHelper (schema validation, typed CRUD, branded Id types)
  └── RowStore (in-memory row index → O(1) has/count, O(m) get/delete)
      └── CellStore (cell semantics: key parsing, typed change events)
          └── YKeyValueLww (generic LWW conflict resolution primitive)
```

Key properties of composition trees:

- Use `└──` for single children, `├──` when siblings exist
- Annotate each node with its responsibility in parentheses
- Show performance characteristics when the refactor changes them
- Before/after pair makes the improvement immediately visible

#### File Relocation Trees

When a refactor physically moves files and that relocation IS the architectural statement, show the move pattern as a tree. This is not "listing files changed" (which the skill forbids) — it's showing the structural reorganization:

```
packages/epicenter/src/
├── shared/
│   ├── y-cell-store.ts      →  dynamic/tables/y-cell-store.ts
│   └── y-row-store.ts       →  dynamic/tables/y-row-store.ts
└── dynamic/tables/
    └── table-helper.ts         (refactored to compose over the above)
```

Use file relocation trees when:

- Files moved between directories as part of a module boundary change
- The new location communicates architectural intent (e.g., "these belong to the tables subsystem, not shared")
- There are 2-6 files moved; more than that, describe the pattern instead

Do NOT use when:

- Files were renamed but stayed in the same directory
- The move is incidental to the real change

ASCII art characters to use: `┌ ┐ └ ┘ ─ │ ├ ┤ ┬ ┴ ┼ ▼ ▲ ◀ ▶ ──→ ←── ⚠️ ✅ ❌`

#### Interleaving Prose and Visuals

Never let prose run for more than a short paragraph without a visual break. The rhythm should be: context → visual → explanation → visual → ...

Each visual (code snippet, ASCII diagram, before/after block) should be preceded by 1-3 sentences of context and optionally followed by a sentence explaining the subtle detail. If you're writing more than 4-5 sentences of prose in a row, you're missing an opportunity for a diagram or code block.

### Other Guidelines

- NEVER include Claude Code or opencode watermarks or attribution in PR titles/descriptions
- PR title should follow same conventional commit format as commits
- Focus on the "why" and "what" of changes, not the "how it was created"
- Include any breaking changes prominently
- Link to relevant issues

### Scanning GitHub Issues Before Writing a PR Description

Before drafting a PR description, run a cursory search of open GitHub issues to identify any that the PR's changes may fix, partially address, or lay groundwork for:

```bash
# List open issues (scan titles for keywords matching the PR's scope)
gh issue list --state open --limit 100 --json number,title,labels

# Read a specific issue to check if the PR addresses it
gh issue view <NUMBER> --json title,body,labels,comments
```

**What to look for:**
- Issues whose root cause matches code you changed (e.g., error handling, provider bugs, API connection issues)
- Feature requests where your changes are a prerequisite (mention as "lays groundwork for")
- Bug reports where your changes improve error messages or diagnostics without fully fixing the bug

**How to reference in the PR description:**
- `Closes #123` — only if the PR fully resolves the issue
- `Partially addresses #123` — if the PR improves the situation but doesn't fully fix it
- `Lays groundwork for #123` — if the PR creates infrastructure that a future PR will use to fix the issue

**Be honest:** Don't claim a fix unless the changes directly address the root cause. Improved error messages or internal refactors that happen to touch related code do not count as fixes.

### Verifying GitHub Usernames

**CRITICAL**: When mentioning GitHub users with `@username` in PR descriptions, issue comments, or any GitHub content, NEVER guess or assume usernames. Always verify programmatically using the GitHub CLI:

```bash
# Get the author of a PR
gh pr view <PR_NUMBER> --json author

# Get the author of an issue
gh issue view <ISSUE_NUMBER> --json author
```

This prevents embarrassing mistakes where you credit the wrong person. Always run the verification command before writing the @mention.

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

For PRs that change APIs, storage structures, or architectural patterns, use this section order:

1. **Opening sentence**: A single crisp sentence summarizing WHAT changed — what was added, removed, or redesigned. This grounds the reader before the motivation.

2. **Why paragraph**: WHY this change exists. What problem does analysis reveal? What was the old design masking? End with a **one-sentence decision summary** if applicable: "We chose X over Y because Z."

3. **Change bullets**: A short bullet list of the specific changes — new APIs, removed patterns, behavioral differences. Bullets complement the prose here; they don't replace it.

4. **API Migration**: Before/after code examples showing the new usage. Mandatory for any API change.

5. **Storage/Data Structure**: ASCII diagrams showing before/after layouts for any structural changes.

6. **Technical Details**: Extension points, type definitions, configuration formats — with code examples.

7. **"Why X?" sections**: Use a named `### Why X?` heading for each significant design decision that needs justification. Write as direct statements, not hedged observations.

8. **Future Work**: What could be re-added later, what's intentionally deferred.

9. **(Optional) Changes Summary / Test Plan**: If included, keep minimal and put at the very end. Most PRs don't need one.

**Key principles**:

- **Visual-first**: Each section should lead with code or ASCII diagrams; prose explains the visuals
- Code snippets and ASCII art are the most scannable — feature them prominently
- Rationale is prose-only (no visual needed); it explains the thinking
- Skip the "Changes" section entirely, or make it minimal at the end

**When to use Architectural format**:

- Public API shape changes (exports, signatures, config formats)
- Persistent data format changes (storage layout, migrations)
- Cross-package contract changes
- New subsystem or major refactor

**When to use Simple format**:

- Localized fix/feature with no consumer migration
- Behavior-preserving internal refactor

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
