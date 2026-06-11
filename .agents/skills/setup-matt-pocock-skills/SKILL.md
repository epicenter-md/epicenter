---
name: setup-matt-pocock-skills
description: Internal bootstrapper for adding issue-tracker, triage-label, and domain-doc configuration under `docs/agents/`. Use only when the user explicitly asks to set up or repair that configuration layer.
disable-model-invocation: true
metadata:
  internal: true
  upstream: mattpocock/skills
  forked: 2026-05-17
---

# Setup Matt Pocock's Skills

Scaffold the optional per-repo configuration that some engineering skills can read:

- **Issue tracker** - where issues live (GitHub by default; local markdown is also supported out of the box)
- **Triage labels** - the strings used for the five canonical triage roles
- **Domain docs** - where `CONTEXT.md` and ADRs live, and the consumer rules for reading them

This is a prompt-driven bootstrapper, not normal working guidance. Do not run it just because another skill mentions issues, triage, TDD, architecture, or domain docs. Use it only when the user explicitly asks to create or repair the `docs/agents/` configuration layer.

## Process

### 1. Explore

Look at the current repo to understand its starting state. Read whatever exists; don't assume:

- `git remote -v` and `.git/config` - is this a GitHub repo? Which one?
- `AGENTS.md` and `CLAUDE.md` at the repo root - does either exist? Is there already an `## Agent skills` section in either?
- `CONTEXT.md` and `CONTEXT-MAP.md` at the repo root
- `docs/adr/` and any `src/*/docs/adr/` directories
- `docs/agents/` - does this skill's prior output already exist?
- `.scratch/` - sign that a local-markdown issue tracker convention is already in use

### 2. Present findings and ask

Summarise what's present and what's missing. Then walk the user through the three decisions **one at a time** - present a section, get the user's answer, then move to the next. Don't dump all three at once.

Assume the user does not know what these terms mean. Each section starts with a short explainer (what it is, why these skills need it, what changes if they pick differently). Then show the choices and the default.

**Section A - Issue tracker.**

> Explainer: The "issue tracker" is where issues live for this repo. Skills like `to-issues`, `triage`, `to-prd`, and `qa` read from and write to it - they need to know whether to call `gh issue create`, write a markdown file under `.scratch/`, or follow some other workflow you describe. Pick the place you actually track work for this repo.

Default posture: these skills were designed for GitHub. If a `git remote` points at GitHub, propose that. If a `git remote` points at GitLab (`gitlab.com` or a self-hosted host), propose GitLab. Otherwise (or if the user prefers), offer:

- **GitHub** - issues live in the repo's GitHub Issues (uses the `gh` CLI)
- **GitLab** - issues live in the repo's GitLab Issues (uses the [`glab`](https://gitlab.com/gitlab-org/cli) CLI)
- **Local markdown** - issues live as files under `.scratch/<feature>/` in this repo (good for solo projects or repos without a remote)
- **Other** (Jira, Linear, etc.) - ask the user to describe the workflow in one paragraph; the skill will record it as freeform prose

**Section B - Triage label vocabulary.**

> Explainer: When the `triage` skill processes an incoming issue, it moves it through a state machine - needs evaluation, waiting on reporter, ready for an AFK agent to pick up, ready for a human, or won't fix. To do that, it needs to apply labels (or the equivalent in your issue tracker) that match strings *you've actually configured*. If your repo already uses different label names (e.g. `bug:triage` instead of `needs-triage`), map them here so the skill applies the right ones instead of creating duplicates.

The five canonical roles:

- `needs-triage` - maintainer needs to evaluate
- `needs-info` - waiting on reporter
- `ready-for-agent` - fully specified, AFK-ready (an agent can pick it up with no human context)
- `ready-for-human` - needs human implementation
- `wontfix` - will not be actioned

Default: each role's string equals its name. Ask the user if they want to override any. If their issue tracker has no existing labels, the defaults are fine.

**Section C - Domain docs.**

> Explainer: Some skills (`improve-codebase-architecture`, `diagnose`, `tdd`) read a `CONTEXT.md` file to learn the project's domain language, and `docs/adr/` for past architectural decisions. They need to know whether the repo has one global context or multiple (e.g. a monorepo with separate frontend/backend contexts) so they look in the right place.

Confirm the layout:

- **Single-context** - one `CONTEXT.md` + `docs/adr/` at the repo root. Most repos are this.
- **Multi-context** - `CONTEXT-MAP.md` at the root pointing to per-context `CONTEXT.md` files (typically a monorepo).

### 3. Confirm and edit

Show the user a draft of:

- The `## Agent skills` block to add to whichever of `CLAUDE.md` / `AGENTS.md` is being edited (see step 4 for selection rules)
- The contents of `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md`

Let them edit before writing.

### 4. Write

**Pick the file to edit:**

- If `AGENTS.md` exists, edit it.
- Else if only `CLAUDE.md` exists, create `AGENTS.md` as the canonical shared
  instruction file and replace `CLAUDE.md` with a compatibility shim that
  contains only `@AGENTS.md`, plus rare Claude-specific notes if already
  present and still necessary.
- If neither exists, create `AGENTS.md` and a sibling `CLAUDE.md` shim with
  `@AGENTS.md`.

Never put shared agent-skill routing only in `CLAUDE.md`. In Epicenter,
`AGENTS.md` is canonical; `CLAUDE.md` is a compatibility shim.

If an `## Agent skills` block already exists in the chosen file, update its contents in-place rather than appending a duplicate. Don't overwrite user edits to the surrounding sections.

The block:

```markdown
## Agent skills

### Issue tracker

[one-line summary of where issues are tracked]. See `docs/agents/issue-tracker.md`.

### Triage labels

[one-line summary of the label vocabulary]. See `docs/agents/triage-labels.md`.

### Domain docs

[one-line summary of layout - "single-context" or "multi-context"]. See `docs/agents/domain.md`.
```

Then write the three docs files using the seed templates in this skill's
`references/` folder as a starting point. Load only the template matching the
user's selected tracker or configuration:

- [issue-tracker-github.md](references/issue-tracker-github.md) - GitHub issue tracker
- [issue-tracker-gitlab.md](references/issue-tracker-gitlab.md) - GitLab issue tracker
- [issue-tracker-local.md](references/issue-tracker-local.md) - local-markdown issue tracker
- [triage-labels.md](references/triage-labels.md) - label mapping
- [domain.md](references/domain.md) - domain doc consumer rules + layout

For "other" issue trackers, write `docs/agents/issue-tracker.md` from scratch using the user's description.

### 5. Done

Tell the user the setup is complete and which engineering skills will now read from these files. Mention they can edit `docs/agents/*.md` directly later - re-running this skill is only necessary if they want to switch issue trackers or restart from scratch.
