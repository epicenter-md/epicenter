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

### Breaking Changes

- Add `!` after type/scope, before colon: `feat(api)!: change endpoint structure`
- Include `BREAKING CHANGE:` in the footer with details
- These trigger MAJOR version bumps in semantic versioning

### Examples Following Your Style:

- `feat(transcription): add model selection for OpenAI providers`
- `fix(sound): resolve audio import paths in assets module`
- `refactor(EditRecordingDialog): implement working copy pattern`
- `docs(README): clarify cost comparison section`
- `chore: update dependencies to latest versions`
- `fix!: change default transcription API endpoint`

## Commit Messages Best Practices

- NEVER include Claude Code or opencode watermarks or attribution
- Each commit should represent a single, atomic change
- Write commits for future developers (including yourself)
- If you need more than one line to describe what you did, consider splitting the commit

## Pull Request Guidelines

- NEVER include Claude Code or opencode watermarks or attribution in PR titles/descriptions
- PR title should follow same conventional commit format as commits
- Focus on the "why" and "what" of changes, not the "how it was created"
- Include any breaking changes prominently
- Link to relevant issues

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

Always use **"Create a merge commit"** when merging pull requests. Never squash.

**GitHub UI:**
- Click "Create a merge commit" (default green button)

**Git CLI:**
```bash
git merge --no-ff <branch>
```

**GitHub CLI:**
```bash
gh pr merge <PR-NUMBER> --merge
# Use --admin flag if needed to bypass branch protections
gh pr merge <PR-NUMBER> --merge --admin
```

### Pull Request Body Format

Use clean paragraph format instead of bullet points or structured sections:

**First Paragraph**: Explain what the change does and what problem it solves.

- Focus on the user-facing benefit or technical improvement
- Use clear, descriptive language about the behavior change

**Subsequent Paragraphs**: Explain how the implementation works.

- Describe the technical approach taken
- Explain key classes, methods, or patterns used
- Include reasoning for technical decisions (e.g., why `flex-1` is needed)

**Example**:

```
This change enables proper vertical scrolling for drawer components when content exceeds the available drawer height. Previously, drawers with long content could overflow without proper scrolling behavior, making it difficult for users to access all content and resulting in poor mobile UX.

To accomplish this, I wrapped the `{@render children?.()}` in a `<div class="flex-1 overflow-y-auto">` container. The `flex-1` class ensures the content area takes up all remaining space after the fixed drag handle at the top, while `overflow-y-auto` enables vertical scrolling when the content height exceeds the available space. This maintains the drag handle as a fixed element while allowing the content to scroll independently, preserving the expected drawer interaction pattern.
```

#### Body Structure

1. **Context Section** (if needed for complex changes):
   - Use bullet points for multiple related observations
   - Mix technical detail with accessible explanations
   - Acknowledge trade-offs: "we'd like to X, but at the same time Y is problematic"

2. **Solution Description**:
   - Lead with what changed in plain language
   - Show code examples inline to illustrate the improvement
   - Compare before/after when it clarifies the change

3. **Technical Details**:
   - Explain the "why" behind architectural decisions
   - Reference philosophical goals: "This doubles down on what people love about..."
   - Connect to long-term vision when relevant

4. **Outstanding Work** (if applicable):
   - List TODOs candidly
   - Be specific about what remains
   - No need to apologize; just state what's left

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
- Bullet points or structured lists
- Section headers like "## Summary" or "## Changes Made"
- Test plans or checklists (unless specifically requested)
- Marketing language or excessive formatting
- Corporate language: "This PR enhances our solution by leveraging..."
- Excessive structure: Multiple heading levels and subsections
- Marketing speak: "game-changing", "revolutionary", "seamless"
- Over-explaining simple changes
- Apologetic tone for reasonable decisions

## What NOT to Include:

- `🤖 Generated with [Claude Code](https://claude.ai/code)`
- `Co-Authored-By: Claude <noreply@anthropic.com>`
- Any references to AI assistance
- `🤖 Generated with [opencode](https://opencode.ai)`
- `Co-Authored-By: opencode <noreply@opencode.ai>`
- Tool attribution or watermarks
