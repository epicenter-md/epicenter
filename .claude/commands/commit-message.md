---
allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git diff:*), Bash(git commit:*)
description: Generate conventional commit message and create git commit
model: claude-sonnet-4-0
---

# Generate Commit Message and Commit

Analyze the currently staged changes and create a git commit with an appropriate conventional commit message.

## Instructions
1. Check `git status` to see what files are staged
2. Analyze staged changes using `git diff --cached`
3. Generate a conventional commit message based on the changes:
   - Type: feat, fix, refactor, docs, test, chore, style, perf, build, ci
   - Scope (optional): component/module name if applicable
   - Description: clear, concise description in imperative mood
4. Execute `git commit` with the generated message

User hint: $ARGUMENTS

## Commit Format
```
<type>[optional scope]: <description>
```