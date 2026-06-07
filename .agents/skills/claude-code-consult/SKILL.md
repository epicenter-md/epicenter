---
name: claude-code-consult
description: Use when the user asks to consult Claude, ask Claude Code, get another model's take, run a taste check, grill a design, find cleaner options, prepare a Claude prompt, or delegate bounded Claude Code work. Covers read-only consults, parallel read-only scouts, and isolated editing workers. Codex stays the harness and owns verification, edits that land, commits, and final correctness.
---

# Claude Code Delegate

Codex is the harness. It frames the task, runs Claude, gates the result, and owns every change that lands in the active worktree. Claude is a consultant, scout, or isolated worker. It is never the final authority.

Pick one operation. Do not treat these as modes of a single call.

```txt
consult   one read-only judgment pass
scout     parallel read-only investigation over disjoint areas
worker    isolated edit attempt in a disposable worktree
```

Default to `consult`. Escalate only when the task shape earns it.

## Prerequisites

Claude delegation requires the local `claude` CLI, working Claude Code auth, and the repo wrapper at `bun run claude:consult`. If those are unavailable, do not improvise an unbounded substitute. Provide the prompt for the user to run, or continue locally without Claude.

## Delegation Test

Do not use Claude just because another agent is available. Use Claude only when at least one condition is true:

```txt
parallelism matters   Codex can keep working while Claude investigates or patches
isolation matters     Claude can work safely in a disposable worktree
diversity matters     another model may catch a design or reasoning mistake
verification is clear the result can be checked by diff, tests, typecheck, docs, or screenshots
```

Keep execution on Codex when the edit is faster to make locally, the task needs delicate repo judgment, the write set overlaps active work, or the result would be mostly prose or vibes.

Claude's reported dollar cost can be an API-price equivalent rather than a direct bill when the user is on a subscription plan. Treat it as a usage-weight signal anyway. A heavy Claude run can still burn plan allowance, block Codex, and make the task harder to reason about.

## Consult

Use for architecture, API shape, naming, taste, clean-break pressure, debugging hypotheses, and risk review.

Every consult must fit in one pass:

1. Ask one concrete question.
2. Give exact file paths or short snippets.
3. Name the critique lens: debugging hypotheses, taste critique, clean-break pressure, risk review, or implementation option review.
4. Say what answer shape is useful.
5. Tell Claude not to edit files, commit, push, delete, run destructive commands, or perform remote admin operations.

Design the prompt so Claude can answer without taking a tool turn. A max-turn cap is not a quality budget. It is a hard conversation turn cap, so a consult that spends turns reading, searching, loading instructions, or asking itself for more context can hit the cap before the final answer is emitted. For one-pass consults, pipe the exact diff or pass a few explicit `--context` files and ask Claude to answer from that supplied material first.

For architecture or API-shape questions, ask Claude to start with one concrete sentence describing the current surface, then look for radical options, asymmetric wins, and clean breaks before suggesting local patches.

Do not paste a template mechanically. Write the prompt a sharp senior engineer would send to another senior engineer.

## Running The Consult

If the user wants to run it themselves, provide only the prompt.

If the user wants Codex to run it, or asks for Claude's judgment as part of the work, use the repo wrapper's background commands. Do not use the synchronous wrapper path. The synchronous path can hang Codex because it waits for Claude inline.

```bash
bun run claude:consult -- start \
  --mode review \
  --question "Find behavioral bugs in this diff only"
```

Pipe narrow context into the wrapper or pass specific files with repeatable `--context` flags. Use `--mode review`, `--mode design`, `--mode tests`, or `--mode docs` to pick the critique lens.

The wrapper uses `claude -p`, `--max-budget-usd`, `--no-session-persistence`, `--disable-slash-commands`, and `--permission-mode dontAsk`. Background jobs use `--output-format stream-json` and store the final result for later retrieval. It intentionally loads the user's normal Claude Code config by default because the local Claude login, model choice, and effort level can live there. Use the wrapper's `--bare` flag only when bare mode is known to have working auth.

The default budget is `$25` so normal strong consults have room to produce a real answer. Do not use a tiny budget cap as a safety rail for strong models: Claude Code can spend enough on setup or cache creation to hit the cap before a reusable `.result` exists. The wrapper rejects budgets under `$1` because local testing showed very small caps can fail before returning a result.

By default, pass context directly and do not expose read/search tools. The wrapper disables tools with `--tools ""` and always denies `Edit`, `Write`, and `Bash`. Add `--read-files` only when Claude needs to read or search extra repo files. In that mode, the wrapper uses `--tools Read,Grep,Glob` and `--allowedTools Read,Grep,Glob`.

Use this shape for reliable consults:

```bash
git diff -- packages/foo/src/bar.ts \
  | bun run claude:consult -- start \
    --mode review \
    --question "Find only behavioral bugs in this diff. If none, say none and name the highest residual risk."
```

Then poll instead of waiting inline:

```bash
bun run claude:consult -- status <job-id>
bun run claude:consult -- result <job-id>
```

Use `cancel` when the job is no longer useful:

```bash
bun run claude:consult -- cancel <job-id>
```

The background runner stores state under `.tmp/claude-consult`, captures
Claude's `stream-json` result, and records the Claude child PID so cancellation
targets the active Claude process. Treat `result` output as Claude's consult
answer, not as a patch to apply blindly.

Use `--context` for small, stable context files:

```bash
bun run claude:consult -- start \
  --mode design \
  --context packages/foo/src/bar.ts \
  --context packages/foo/src/bar.test.ts \
  --question "Is this API boundary cohesive? Answer from these files first."
```

Avoid broad prompts:

```txt
review the whole repo
think deeply until you find all problems
read whatever files you need
continue until done
```

Those shapes convert a consult into an exploration loop. Exploration should be split into scouts with separate budgets and exact scopes.

Do not use direct `claude -p` for repo consults. Use the wrapper background commands so Codex never waits inline.

Add `--max-turns` only when the user explicitly asks for a hard turn cap. Do not set `--model` or `--effort` unless the user explicitly asks for an override; otherwise, let the local Claude config decide.

For pure judgment consults that do not need workspace files, omit `--read-files`. The wrapper then passes `--tools ""` internally.

Bare mode may not see the user's Claude Code login. If a `--bare` call reports `Not logged in`, retry without `--bare` before changing auth state.

## Scouts

Use scouts when independent read-only investigations can run in parallel without sharing context.

Good scout work:

```txt
one package boundary
one confusing call path
one external library behavior
one diff review lens
one docs or test search
```

Bad scout work:

```txt
open-ended "think about everything"
duplicate searches over the same files
tasks where the next local step is blocked on every result
anything that requires editing
```

Launch each scout as its own bounded background wrapper job. Give each scout a concrete question, exact search scope, and answer shape. Codex reconciles the reports and verifies contradictions against local files.

```bash
bun run claude:consult -- start \
  --mode review \
  --read-files \
  --budget-usd 3 \
  --question "Within packages/foo only, find one likely cause of the failing sync test. Return evidence and the smallest next check."
```

Keep fan-out small. Default to one scout. Use two or three when the work is genuinely parallel. Avoid more than four unless the user explicitly asks for a broad sweep.

## Workers

Claude may edit only as an isolated worker. Use this for mechanical, well-specified, verifiable work:

```txt
codemods
mechanical renames
scaffolding
test generation for a known behavior
repetitive edits across disjoint files
alternative patch attempts
```

Do not use workers for judgment work, product decisions, architecture taste, broad refactors, or anything that cannot be checked by diff plus tests, typecheck, screenshots, or another deterministic signal.

Hard rules:

1. Claude never edits Codex's active worktree.
2. Claude edits only in a disposable git worktree on its own branch.
3. Each worker owns a disjoint write set.
4. Claude does not stage, commit, push, force-push, delete branches, or run production/admin operations.
5. Codex reviews the worker diff, applies selected changes, stages specific files, verifies, and commits if requested.

Prefer creating the worktree yourself so the isolation is explicit:

```bash
git worktree add ../.cc-work/<task> -b cc/<task>
```

Then run Claude from that worktree:

```bash
(
  cd ../.cc-work/<task> &&
  claude -p "[mechanical task]" \
    --tools "Read,Grep,Glob,Edit,Write,Bash" \
    --allowedTools "Bash(bun run typecheck)" \
    --permission-mode acceptEdits \
    --output-format json \
    --max-budget-usd 2
)
```

Run editing workers only through a bounded execution path: a local timeout command, a supervising shell, or another process wrapper that can terminate the Claude process. If no bounded path is available, do not start the worker.

Add only the Bash commands the task needs. Avoid broad `Bash` allowlists for workers.

Do not use `--bare` for editing workers unless you inject the repo rules explicitly. Bare mode skips normal project instruction discovery, which can drop the rules this repo cares about: `bun`, specific-file staging, no AI attribution, no em or en dashes, and no direct `console.*` in library code.

Never use `bypassPermissions`, `--dangerously-skip-permissions`, or `--allow-dangerously-skip-permissions` for a worker.

## Blocking Behavior

Repo-wrapper consults must use `start`, then `status`, `result`, or `cancel`. Do not run a foreground wrapper consult and wait for it. They should still be focused and budgeted.

Scouts, workers, and large fan-out runs must not block Codex indefinitely. Use a wall-clock timeout when practical. If Claude hangs, runs out of budget, lacks auth, hits a turn limit, or returns generic output, record that and continue with the best local path.

Only stop the overall task for Claude when the user explicitly made Claude's answer the deliverable.

When the wrapper hits `--max-turns` or `--max-budget-usd`, treat the run as failed even if Claude may have reasoned internally. The usable background consult answer is the stored result returned by `bun run claude:consult -- result <job-id>`. If the final result is missing, do not infer a partial answer from the failed run. Tighten the prompt, reduce context, remove `--read-files`, or split into scouts.

Do not leave Claude background sessions running. If you use background sessions, capture their IDs, check logs, stop stuck work, and remove finished sessions.

## Budgets

Every delegated Claude run must have a budget. Prefer the smallest budget that can answer the prompt, and use turn caps only when truncation is better than waiting.

```txt
consult  generous budget as the bound, no default turn cap
scout    low budget per scout, small fan-out, fan-in through Codex
worker   task-sized budget, wall-clock timeout, diff review required
```

Do not run open-ended loops. Do not ask Claude to keep working until done. If the task cannot be bounded, keep it in Codex.

## Verification

Treat Claude output like a strong code review comment, not truth.

For consults and scouts:

1. Check job status before reading the result.
2. Read the stored result with `bun run claude:consult -- result <job-id>`.
3. Separate concrete findings from opinion.
4. Check each claim against local files, installed types, official docs, DeepWiki, or tests.
5. Keep only recommendations that fit repo constraints.

For workers:

1. Read the full worker diff.
2. Reject unrelated changes.
3. Check repo conventions: no forbidden punctuation, no AI attribution, no broad git staging, no direct `console.*` in library code.
4. Run the relevant `bun` commands in the active worktree after applying selected changes.
5. Treat Claude's self-reported test output as supporting evidence only.

## Forbidden

Never let Claude:

```txt
edit the active Codex worktree
edit a shared checkout used by another agent
run without a budget for delegated work
run destructive git commands
stage with git add . or git add -A
commit or push
run :remote scripts or production admin operations
use bypassPermissions for delegated work
coordinate overlapping write sets
turn a consult into an edit run
```

If Claude's answer is generic, unsupported, contradicted by local files, or incompatible with this repo, discard that part and say so.
