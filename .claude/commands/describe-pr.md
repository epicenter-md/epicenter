---
description: Generate comprehensive PR descriptions and update the PR
---

# Generate PR Description

You are tasked with generating a comprehensive pull request description.

## Steps to Follow

### 1. Identify the PR to Describe

- Check if the current branch has an associated PR:
  ```bash
  gh pr view --json url,number,title,state 2>/dev/null
  ```
- If no PR exists for the current branch, list open PRs:
  ```bash
  gh pr list --limit 10 --json number,title,headRefName,author
  ```
- Ask the user which PR they want to describe if unclear

### 2. Gather Comprehensive PR Information

```bash
# Get the full PR diff
gh pr diff {number}

# Get commit history
gh pr view {number} --json commits

# Review the base branch
gh pr view {number} --json baseRefName

# Get PR metadata
gh pr view {number} --json url,title,number,state
```

If you get an error about no default remote repository, instruct the user to run `gh repo set-default` and select the appropriate repository.

### 3. Analyze the Changes Thoroughly

- Read through the entire diff carefully
- For context, read any files that are referenced but not shown in the diff
- Understand the purpose and impact of each change
- Identify user-facing changes vs internal implementation details
- Look for breaking changes or migration requirements

### 4. Run Verification Commands (Where Possible)

For verification steps that can be automated:
- If it's a command you can run (like `bun run check`, `bun test`, etc.), run it
- If it passes, note the success
- If it fails, note what failed
- If it requires manual testing (UI interactions, external services), note for user

### 5. Generate the Description

Use this format:

```markdown
## Summary

[1-3 sentences explaining what this PR does and why]

[Additional paragraph explaining how the implementation works if needed]

## Verification

**Automated (completed):**
- [x] Type checking passes: `bun run check`
- [x] Tests pass: `bun test`
- [ ] Linting: Failed - [explanation]

**Manual testing needed:**
- [ ] Feature works correctly in UI
- [ ] No regressions in related features
```

### 6. Update the PR

Update the PR description directly:

```bash
gh pr edit {number} --body "$(cat <<'EOF'
[Your generated description here]
EOF
)"
```

Confirm the update was successful.

## Important Notes

- Be thorough but concise - descriptions should be scannable
- Focus on the "why" as much as the "what"
- Include any breaking changes or migration notes prominently
- If the PR touches multiple components, organize the description accordingly
- Always attempt to run verification commands when possible
- Clearly communicate which verification steps need manual testing
- **Do NOT list files changed** - GitHub's "Files changed" tab already shows this
- The description should explain WHY and HOW, not enumerate WHAT files

## PR Description Guidelines

From the project's git rules:

- Use clean paragraph format instead of bullet points or structured sections
- **First Paragraph**: Explain what the change does and what problem it solves
- **Subsequent Paragraphs**: Explain how the implementation works
- Avoid: Section headers like "## Summary" or "## Changes Made", bullet point lists, marketing language
- Focus on conversational but precise language
