### Goal

Create a separate, runnable checkout of Whispering that automatically merges multiple branches together for day-to-day use without disturbing the main working repository and its active branches. Also introduce a new branch for a macOS auto pause/resume media feature.

### Proposed Approach: Git worktree based "daily driver" branch

Use `git worktree` to maintain a sibling checkout that tracks a dedicated merge branch (e.g., `dave/daily-driver`). This branch will regularly merge these sources:

- `whispering-makefile` (adds `apps/whispering/Makefile`)
- `Dave-MakeSoundsNotImpactMediaControl` (or optionally `Sounds-not-Impact-Media-Debug` if preferred)
- `Dave-auto-pause-resume-media` (new feature branch we will create with an initial no-op change)

This keeps your main repo free to stay on any branch while the worktree is the combined "daily driver" you run.

Key reasons for worktree:
- Multiple checkouts from the same repo without extra clones
- No extra remotes; shares objects, saves disk
- Clean separation of working directory for running the combined build

### High-level flow

1) In your current repo, create a persistent merge branch `dave/daily-driver`.
2) Add a worktree at `../whispering-daily-driver` checked out to `dave/daily-driver`.
3) Provide an orchestration script that:
   - fetches latest
   - checks out `dave/daily-driver`
   - merges in the designated branches in a fixed order
   - resolves trivial conflicts using ours/theirs strategy where appropriate (prompt when non-trivial)
   - runs `make dev` from `apps/whispering/` in the worktree

You can continue normal work in your main repo. When you want to use the app with all three branches, run the orchestrator; it updates the worktree and starts the app.

### Branch list and merge order

Default order (later items take precedence if overlapping changes):
1. `whispering-makefile`
2. `Dave-MakeSoundsNotImpactMediaControl` (or `Sounds-not-Impact-Media-Debug` if you confirm)
3. `Dave-auto-pause-resume-media` (new feature branch with incremental changes going forward)

This order minimizes churn by layering the operational Makefile first, then your media control behavior, then the new auto pause/resume logic.

### Orchestrator outline

We will add a script (kept in this repo under `scripts/`) that works on the parent directory to manage the worktree:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
WORKTREE_DIR="${REPO_DIR}/../whispering-daily-driver"
MERGE_BRANCH="dave/daily-driver"
BRANCHES=(
  "whispering-makefile"
  "Dave-MakeSoundsNotImpactMediaControl" # or Sounds-not-Impact-Media-Debug
  "Dave-auto-pause-resume-media"
)

cd "$REPO_DIR"

# Ensure merge branch exists
if ! git rev-parse --verify "$MERGE_BRANCH" >/dev/null 2>&1; then
  git checkout -b "$MERGE_BRANCH" origin/main || git checkout -b "$MERGE_BRANCH" main
fi

# Ensure worktree exists
if [ ! -d "$WORKTREE_DIR/.git" ]; then
  git worktree add "$WORKTREE_DIR" "$MERGE_BRANCH"
fi

# Update and merge
git fetch --all --prune

pushd "$WORKTREE_DIR" >/dev/null
git checkout "$MERGE_BRANCH"
git reset --hard origin/main || git reset --hard main

for b in "${BRANCHES[@]}"; do
  git fetch origin "$b" || true
  if git rev-parse --verify "origin/$b" >/dev/null 2>&1; then
    echo "Merging $b into $MERGE_BRANCH"
    git merge --no-edit "origin/$b" || {
      echo "Merge conflict encountered for $b. Resolve here, commit, then re-run." >&2
      exit 1
    }
  else
    echo "Warning: branch $b not found on origin; skipping"
  fi
done

# Launch dev
if [ -f apps/whispering/Makefile ]; then
  (cd apps/whispering && make dev)
else
  echo "apps/whispering/Makefile not found; ensure whispering-makefile branch is merged"
  exit 1
fi

popd >/dev/null
```

Notes:
- We reset `dave/daily-driver` to `main` (or `origin/main`) before each merge sequence to ensure a clean base. If you prefer incremental fast-forwards, we can switch to periodic merges without reset.
- If merge conflicts occur, the script stops and asks you to resolve them in the worktree. After resolving and committing, re-run the script.

### New feature: macOS auto pause/resume media

Scope for the initial branch `Dave-auto-pause-resume-media`:
- Add a settings flag in the main settings UI: “Auto pause/resume media on record”.
- macOS only: on command sequence start, issue a system media pause; on end, issue media play. If no media session is active, do nothing.
- Start with a small, inconsequential change to establish the branch; implement the real behavior in follow-ups.

Implementation direction (later PRs):
- For macOS, prefer a native approach via Tauri command or AppleScript bridge. Options include:
  - AppleScript via `osascript` to send media key events
  - Tauri plugin calling MediaRemote (if feasible) or using lower-level APIs
- Guard feature behind settings flag and platform detection.

### Files and locations (proposed)

- `scripts/daily-driver-merge-and-run.sh`: Orchestrator (committed to this repo).
- Worktree directory: `../whispering-daily-driver` relative to repo root.
- Merge target branch: `dave/daily-driver`.

### Open confirmations needed

- Confirm exact branch names:
  - Keep `Dave-MakeSoundsNotImpactMediaControl` or use `Sounds-not-Impact-Media-Debug` instead?
  - Confirm the `whispering-makefile` branch name.
- Confirm `make dev` is the intended target in `apps/whispering/Makefile`.
- Confirm the sibling path `../whispering-daily-driver` is acceptable.

### TODOs

1. Create `Dave-auto-pause-resume-media` branch with a trivial change.
2. Add `scripts/daily-driver-merge-and-run.sh` orchestrator.
3. Initialize `dave/daily-driver` merge branch and worktree at `../whispering-daily-driver`.
4. Wire branch list and merge order; handle fetch/reset semantics.
5. Validate merges with your designated branches; resolve any conflicts.
6. Run `make dev` in the worktree and confirm end-to-end behavior.
7. Implement real macOS pause/resume logic behind settings flag (follow-up).

### Rollback

To remove the worktree safely:

```bash
git worktree remove ../whispering-daily-driver
git branch -D dave/daily-driver  # only if you want to drop the branch
```

If you want a clone-based alternative (fully separate repo) instead of worktrees, we can swap to a script that clones into `../whispering-daily-driver`, adds origin remote, then merges branches similarly. Worktrees are lighter and share objects, so they are the recommended default.


