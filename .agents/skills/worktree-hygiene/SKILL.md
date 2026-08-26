---
name: worktree-hygiene
description: Safely reap merged Git worktrees and branches across Epicenter harnesses. Use when cleaning `git worktree list`, removing orphaned or detached worktrees, or deciding whether one is safe to delete, not when creating branches or commits.
metadata:
  author: epicenter
  version: '1.0'
---

# Worktree Hygiene

> **Related Skills**: [git](../git/SKILL.md) for branch creation, staging, and commit messages. [standalone-commits](../standalone-commits/SKILL.md) for reviewable units. [pull-request](../pull-request/SKILL.md) for merge strategy.

Four harnesses (warp, codex, opencode, conductor) mint worktrees here and nothing reaps them, so they accumulate. The cure is to reap on close: when a branch lands, remove its worktree and delete the branch in the same motion. This skill is the safe procedure for doing that, one-off or as a periodic sweep.

## The reap signal (and the trap)

"Branch merged" is **not** sufficient to reap. A merged branch routinely carries live uncommitted edits in its working tree; removing it with `--force` destroys that work. The real signal is:

```txt
reap = (branch fully contained in origin/main)  AND  (working tree clean OR only throwaway dirt)
```

Use `git merge-base --is-ancestor <branch> origin/main` for containment: if true, every commit on the branch is in `origin/main`, which is airtight even when the branch sits on a stacked base. `git cherry origin/main <branch>` shows unmerged commits (`+` lines).

## Audit procedure

Fetch first if `origin/main` is stale, then classify every worktree:

```bash
cd <main-checkout>; base=origin/main
git worktree list --porcelain | awk '/^branch /{print $2}' | sed 's#refs/heads/##' | while read b; do
  [ -z "$b" ] && continue
  ahead=$(git cherry "$base" "$b" 2>/dev/null | grep -c '^+')
  if git merge-base --is-ancestor "$b" "$base" 2>/dev/null; then st="MERGED"; else st="$ahead unmerged"; fi
  printf "%-50s %s\n" "$b" "$st"
done
```

For each MERGED worktree, check its working tree with `git -C <path> status --porcelain` (no output = clean). Inspect dirty file lists before deciding: lockfile-only churn is throwaway; modified source or unique untracked files are real work. Detached-HEAD worktrees have no branch line; test their tip with `git merge-base --is-ancestor <sha> origin/main`.

## Decide per worktree

```txt
merged + clean                 -> reap: git worktree remove <path>; git branch -d/-D <branch>
merged + throwaway dirt only   -> reap: git worktree remove --force <path>; git branch -d/-D <branch>
detached + merged + clean      -> reap: git worktree remove <path>   (no branch to delete)
merged + REAL uncommitted work -> preserve. Branch or commit the work first; do not reap.
detached + REAL uncommitted    -> anchor before anything: git -C <path> switch -c holding/<name>
unmerged commits               -> leave alone (active work)
```

## Reaping is destructive: gate it

`git worktree remove` and `git branch -d` are destructive (AGENTS.md: destructive actions need approval). For a sweep, present an approve-list of exact commands grouped by tier before running any of them. Never reap on a self-reported "it's merged"; run the audit yourself.

- `git branch -d` refuses unless the branch is merged into the current HEAD. If local `main` lags `origin/main`, it will refuse a branch that is merged only on the remote; `-D` is then justified by the `merge-base --is-ancestor origin/main` proof.
- `git worktree remove` can fail with `Directory not empty` when ignored files (node_modules, `.DS_Store`) remain. It still de-registers the worktree. Finish with `git worktree prune` then `rm -rf <path>`.
- The harnesses spawn and mutate worktrees continuously, even mid-sweep. Re-run the audit at the end; treat reaping as ongoing discipline, not a one-time event.

## Repo-specific worktree gotchas

- **`git stash` is shared across all worktrees here.** A bare `git stash`/`stash pop` can grab another worktree's entry. Prefer explicit branches; avoid stash.
- **Animal-named warp branches are stacked on unmerged bases**, cut from whatever was checked out rather than clean `origin/main`. Before opening a PR from one, run `git diff --stat origin/main...HEAD` and confirm scope; unrelated work rides along otherwise.
- **Verify HEAD before committing in a worktree** (`git rev-parse --abbrev-ref HEAD`). A handoff may claim a "fresh worktree on branch X" that does not exist; these stay checked out on the base branch itself.

## Invariant: one owner per worktree

Each worktree and branch has a single owner (the harness/agent that created it). Do not reap or commit into a worktree you do not own without confirming it is abandoned; a clean-looking tree may belong to a live session.

## Final checks

1. Re-run the audit; confirm reaped paths are gone with `git worktree list`.
2. `git worktree prune` to clear stale registrations.
3. Confirm any anchored `holding/*` branches still hold their edits.
</content>
</invoke>
