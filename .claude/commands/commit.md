---
description: Create git commits with user approval and no Claude attribution
---

# Commit Changes

You are tasked with creating git commits for the changes made during this session.

## Process

### 1. Think About What Changed

- Review the conversation history and understand what was accomplished
- Run `git status` to see current changes
- Run `git diff` to understand the modifications
- Consider whether changes should be one commit or multiple logical commits

### 2. Plan Your Commit(s)

- Identify which files belong together
- Draft clear, descriptive commit messages
- Use imperative mood in commit messages ("add" not "added")
- Focus on why the changes were made, not just what
- Follow conventional commits format: `type(scope): description`

### Commit Types
- `feat`: New features
- `fix`: Bug fixes
- `docs`: Documentation only changes
- `refactor`: Code changes that neither fix bugs nor add features
- `perf`: Performance improvements
- `test`: Adding or modifying tests
- `chore`: Maintenance tasks, dependency updates
- `style`: Code style changes (formatting, etc.)
- `build`: Changes to build system or dependencies

### 3. Present Your Plan to the User

List the files you plan to add for each commit and show the commit message(s) you'll use:

```
I plan to create [N] commit(s):

**Commit 1**: `feat(transcription): add model selection for providers`
Files:
- apps/whispering/src/lib/services/transcription.ts
- apps/whispering/src/routes/settings/+page.svelte

**Commit 2**: `fix(audio): resolve buffer overflow on long recordings`
Files:
- apps/whispering/src/lib/services/audio.ts

Shall I proceed?
```

### 4. Execute Upon Confirmation

- Use `git add` with specific files (never use `-A` or `.`)
- Create commits with your planned messages
- Show the result with `git log --oneline -n [number]`

## Important Rules

- **NEVER add co-author information or Claude attribution**
- Commits should be authored solely by the user
- Do not include any "Generated with Claude" messages
- Do not add "Co-Authored-By" lines
- Write commit messages as if the user wrote them
- Start commit description with lowercase after the colon
- No period at the end of the commit message
- Keep first line under 50-72 characters

## Commit Message Format

Use a HEREDOC for multi-line messages:

```bash
git commit -m "$(cat <<'EOF'
feat(scope): brief description

Optional longer explanation of what and why.
EOF
)"
```

## Remember

- You have the full context of what was done in this session
- Group related changes together
- Keep commits focused and atomic when possible
- The user trusts your judgment - they asked you to commit
- Always ask for confirmation before actually committing
