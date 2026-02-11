# Git Email Mismatch: Why Your GitHub Contributions Aren't Showing

I just discovered holes in my GitHub contribution graph despite making commits daily. Turns out the issue was simple: my local git email didn't match any email registered on GitHub.

## The Problem

GitHub only counts commits toward your contribution graph if the commit email is:

1. Verified and attached to your GitHub account, OR
2. Your GitHub noreply email (`username@users.noreply.github.com`)

If you're committing with `git@yourdomain.com` but that email isn't added to GitHub, those commits exist in the repo but don't show on your profile.

## How to Diagnose

Check what email your commits are using:

```bash
git log --format="%ae" -10  # Shows last 10 commit emails
```

Compare against what GitHub knows:

- Go to https://github.com/settings/emails
- See which emails are verified

If they don't match, you've found the problem.

## The Fix

**Option 1: Add your current email to GitHub (recommended)**

1. Go to https://github.com/settings/emails
2. Click "Add email address"
3. Add your git email (e.g., `git@yourdomain.com`)
4. Verify it via the confirmation email

GitHub will retroactively attribute all past commits with that email to your account. The contribution graph updates within minutes to hours.

**Option 2: Change your git email to match GitHub**

```bash
git config --global user.email "your-verified-email@example.com"
```

This only affects future commits—past commits keep their original email.

## Which Email Should You Use?

| Email Type                                           | Pros                                     | Cons                                     |
| ---------------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| Custom domain (`git@yourdomain.com`)                 | Professional, portable across platforms  | Must add to each git hosting service     |
| GitHub noreply (`123+user@users.noreply.github.com`) | Always works on GitHub, hides real email | GitHub-specific, looks less professional |

**My recommendation:** Use your professional email (`git@yourdomain.com`) and add it to GitHub. It works everywhere—GitHub, GitLab, Bitbucket—and looks better in commit history.

## Verification Checklist

After fixing, verify your setup:

```bash
# Check global config
git config --global user.email

# Check local repo override (if any)
git config user.email

# Verify they match what's in GitHub settings
```

## Common Gotchas

**Merge commits use a different email**: When you merge via GitHub's UI or CLI with `gh pr merge`, GitHub uses your noreply email. Direct commits use whatever's in your git config. This can create a mix in your history.

**Organization repos**: Commits to organization repos only count if:

- You're a member of the org, OR
- You've forked the repo and your commits are merged

**Private repos**: Only count if you have the "Private contributions" setting enabled in your GitHub profile.

## The Takeaway

Before starting work on a new machine or repo, run:

```bash
git config user.email
```

Make sure it matches a verified email on GitHub. Two minutes of checking saves weeks of invisible contributions.
