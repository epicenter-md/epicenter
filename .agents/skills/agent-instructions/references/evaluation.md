# Skill Evaluation

Load this when tuning description routing, comparing skill versions, diagnosing why an agent used a skill poorly, or checking the source guidance behind this skill.

## Table Of Contents

- [Source Links](#source-links)
- [Authority Split](#authority-split)
- [Prompt Set](#prompt-set)
- [Baseline](#baseline)
- [Assertions](#assertions)
- [Run The Harness](#run-the-harness)
- [Routing Surfaces](#routing-surfaces)
- [Output Quality Eval](#output-quality-eval)
- [Script Requirements](#script-requirements)
- [Failure Modes](#failure-modes)
- [Concrete Examples](#concrete-examples)
- [Execution Trace Review](#execution-trace-review)
- [Iteration Loop](#iteration-loop)
- [Security And Portability](#security-and-portability)

## Source Links

- Agent Skills overview: https://agentskills.io/home
- Agent Skills best practices: https://agentskills.io/skill-creation/best-practices
- Optimizing skill descriptions: https://agentskills.io/skill-creation/optimizing-descriptions
- Evaluating skills: https://agentskills.io/skill-creation/evaluating-skills
- Using scripts in skills: https://agentskills.io/skill-creation/using-scripts
- Anthropic engineering post: https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Vercel Agent Skills docs: https://vercel.com/docs/agent-resources/skills
- Vercel skills CLI README: https://github.com/vercel-labs/skills/blob/main/README.md
- Matt Pocock skills repo: https://github.com/mattpocock/skills
- Matt Pocock write-a-skill: https://github.com/mattpocock/skills/blob/main/skills/productivity/write-a-skill/SKILL.md
- OpenAI Academy skills resource: https://academy.openai.com/public/resources/skills

## Authority Split

- Vercel `skills` CLI: accepted frontmatter, discovery paths, install behavior, and compatibility checks.
- Agent Skills docs: authoring, progressive disclosure, eval, and script design guidance.
- OpenAI Academy: portability, playbook shape, sharing, connector, and workspace permission behavior.
- Matt Pocock skills: practical examples and taste calibration, not the format source of truth.

## Prompt Set

Start small:

- 2 or 3 prompts that should trigger the skill.
- 1 or 2 near-miss prompts that share vocabulary but should not trigger it.
- Varied styles: casual, precise, incomplete, and edge-case phrasing.

For serious trigger tuning, aim for about 20 prompts: 8 to 10 that should trigger and 8 to 10 that should not. Keep separate train and validation examples. Revise from the train set, then choose the best description by validation behavior.

Run each prompt multiple times when possible, commonly 3 runs, because routing can vary. Track trigger rate instead of trusting one run. Stop early only when the outcome is already clear. After applying the selected description, sanity-check with 5 to 10 fresh prompts.

## Baseline

Compare against the right baseline:

- New skill: compare against no skill.
- Existing skill: compare against the previous skill version.
- Description-only change: compare routing behavior before and after the edit.

Use clean contexts when possible. Do not tell the evaluating agent the expected answer.

## Assertions

Use assertions only when they can be checked with evidence:

- Discovery assertion: the skill appeared in CLI listing.
- Routing assertion: the skill triggered or did not trigger for the prompt.
- Output shape assertion: required sections, files, fields, or commands exist.
- Policy assertion: required or forbidden project conventions were followed.
- Mechanical assertion: a script or command can verify the result.

Avoid brittle phrase matching. Assertions should check outcomes, not exact wording.

## Run The Harness

`scripts/run-trigger-eval.ts` runs a stored corpus of should-trigger and
near-miss prompts. Each case carries a prompt, the anchor phrases that prompt
contains, the skill that should own it (`null` for a near miss), and the skills
that must not answer. Two corpora ship:

```txt
evals/routing.json         the default. Covers the two boundaries where a wrong
                           pick costs the most: the review/simplification
                           cluster, where several skills legitimately overlap,
                           and the Claude enlistment/handoff cluster,
                           where the wrong choice burns a whole session.
evals/always-on-gate.json  the always-on surface itself, not any one skill.
                           Pass it with --corpus. See Routing Surfaces below.
```

```bash
bun run agent-instructions/scripts/run-trigger-eval.ts
```

The default pass is offline and free. It reports four conditions per anchor:
nobody claims it, several skills claim it, the expected owner carries no hook
for it, or a forbidden skill claims it.

**That pass measures descriptions, not routing.** A description can carry a
near-miss clause no substring scan can weigh, and a model can route correctly on
intent with zero lexical overlap. Both happen in this library. Use the offline
pass as a smoke test on description coverage, and never quote it as evidence
that routing works.

To measure routing, spend the quota:

```bash
bun run agent-instructions/scripts/run-trigger-eval.ts --live
```

`--live` spawns the Claude CLI once per case with the Skill tool as its only
tool, tells it to load the skill it would use and stop, and records what it
actually loaded. That is a real model decision over the real descriptions, and
it is still a proxy: a session restricted to one tool and told not to work is
not the session a skill gets selected in for real. It needs an authenticated
CLI and is opt-in for that reason; the test suite never invokes it.

Every live run is bounded. `--timeout-ms` kills one hung probe and records it as
a timeout rather than a routing failure, `--budget-ms` (default 15 minutes) ends
the run and exits non-zero with the count of cases that never ran, and `--limit`
reports what it dropped. A missing `claude` on PATH is a usage error, not a
silent skip.

`--live` drives the Claude CLI, so it can only measure Claude-routed cases. A
case carrying `"router": "codex"` is reported as `NOT MEASURED` and left out of
the pass count. `consult-claude` is written for a Codex session, so a Claude
probe answering it picks a neighbour every time; that is a category error in
the measurement, not a defect in the description. Measuring it needs a
Codex-side probe that does not exist yet. Do not edit a description on the
strength of a probe that could not have routed to it.

Routing varies between runs, so re-run rather than trusting one pass, as
[Prompt Set](#prompt-set) says. `--runs <n>` does that per case and reports a
pass rate, marking a case that passes some runs and fails others as `flaky`
instead of letting the last run decide. For a model or effort sweep, run one
cell per file and diff them:

```bash
bun run agent-instructions/scripts/run-trigger-eval.ts --live \
  --model claude-opus-5 --effort high --out run-opus5-high.json
```

The result file records the model, the effort, the runs per case, whether the
budget was exhausted, which cases went unmeasured, and a digest of the always-on
instructions, so a stale or partial file cannot be mistaken for a clean one.
`--verify-runs <dir>` reads that digest back and reports whether a stored run
still describes the working tree, which is the question to settle before quoting
any rate from `evals/runs/`. Other flags: `--case <id>` to run one case,
`--strict` to turn the offline pass into a gate, `--json` for machine reading.

Extend the corpus when a routing bug shows up in real use. A case is only valid
when each anchor appears verbatim in its prompt and every named skill exists;
`bun test scripts/run-trigger-eval.test.ts` enforces both, so a renamed skill
cannot leave a case silently measuring nothing.

## Routing Surfaces

Descriptions are not the only thing that routes. In the Claude Code probe used
here, `AGENTS.md` is present before a description is weighed and it names skills
outright, so it claims phrases too. A probe obeyed it: an `AGENTS.md` sentence
sending overflow reports to `documentation` beat `styling`'s own description 3
times out of 3. That is why the run record carries an `instructions` digest next
to `model` and `effort`. Two result files can disagree with no description edit
between them.

Measure the gate by running one corpus against two worktrees that differ only in
`AGENTS.md`, never by editing the file under a running probe: each probe re-reads
it from disk at spawn. `evals/always-on-gate.json` is the corpus for the gate
itself, split into phrases a description already owns and phrases none does.

The historical A/B over that corpus, 5 runs per case, reported one asymmetry:

```txt
no description owns the phrase  -> the gate decides the route
a description owns the phrase   -> the gate changes nothing
```

Deleting the gate moved a phrase nothing claimed by 100 points ("anything before
I stage this" went from `post-implementation-review` 5/5 to `standalone-commits`
5/5) and moved a phrase `greenfield-clean-breaks` owns by 0 points (5/5 either
way). These stored records are stale and do not preserve complete arm snapshots,
so they are context for the hypothesis rather than independently replayable
proof. Repeat the comparison in isolated worktrees before relying on a rate.

A third arm then shortened the gate instead of deleting it, dropping the
owned-phrase triggers and three sentences naming skills that own their own
phrases. The owned phrases did not move, as the asymmetry predicts. The orphan
phrases did: "clean up" fell from 4/5 to 2/5 and "challenge" from 1/5 to 0/5,
even though the shortened gate still named "clean up" outright.

So gate influence is not the sum of its clauses. A shorter paragraph pulled less
toward the skill it still named, which makes **deleting an inert clause a
candidate rather than a free deletion**. That arm changed two things at once, so
which half cost the strength is still unknown.

What this supports when writing always-on instructions:

- A gate clause naming a phrase some description already claims does not change
  that phrase's route. `audit-routing-collisions.ts` reports it as a second
  claimant, which makes it a deletion candidate, not a proven-free deletion.
- A gate clause is the only thing that routes a broad intent no description
  claims. Those are the clauses that carry the paragraph.
- Any edit to the gate is a routing change. Measure it across two worktrees the
  way a description edit gets measured.

None of this says the gate routes *well*. It shows the gate causes the route;
the repository's intent decides whether that route is the right one.

## Output Quality Eval

Use this structure when the user asks to prove a skill works or compare versions:

```txt
evals/
|-- evals.json          prompt, expected_output, optional files
|-- files/              input files for eval cases
`-- runs/
    `-- iteration-1/
        |-- case-id/
        |   |-- with_skill/
        |   `-- without_skill/
        |-- grading.json
        |-- timing.json
        `-- benchmark.json
```

Run each case against the right baseline: no skill for a new skill, previous version for an update. Capture outputs, transcripts, token counts, and duration when available. Grade with concrete evidence, aggregate pass rates, compare deltas, and inspect assertions that always pass, always fail, or vary between runs.

Human feedback still matters. Save concise notes when the output is technically valid but unhelpful, overbroad, or not in the user's voice.

## Script Requirements

`SKILL.md` states the shape a script takes here. Two things it does not carry:

- A script that changes files or external state is idempotent or dry-run
  capable, because an agent will re-run it after a partial failure.
- Bun inline dependency auto-install is not reliable inside this monorepo. An
  existing parent `node_modules` changes whether inline imports auto-install, so
  state the prerequisite or take an explicit workspace dependency.

Prefer `bun`, `bun run`, and `bun x`. Pin versions when command behavior must be
reproducible.

## Failure Modes

| Symptom | Likely Cause | Correction | Re-test |
| --- | --- | --- | --- |
| Skill does not trigger | Description misses user intent | Rewrite description around task phrasing and file/tool cues | Run should-trigger prompts 3 times |
| Skill overfires | Description is too broad | Add near-miss boundaries and remove generic trigger language | Run should-not-trigger prompts |
| Agent ignores reference | Load condition is vague | Replace "see references" with "read X when Y happens" | Re-run the prompt that needed the reference |
| CLI validation fails | Frontmatter or discovery shape is invalid | Fix `name`, `description`, path, or unsupported metadata | Run the source-directory command from `SKILL.md`; add `--skill <name>` for an individual or internal skill |
| Imported skill conflicts with AGENTS.md | Upstream guidance assumes different repo rules | Keep local AGENTS.md rules and adapt or reject the skill | Re-run local review checklist |
| Source example uses `npx` | Upstream command is not Bun-adapted | Use `bun x --package skills skills ...` for skills CLI, or preserve package with `bun x`/`bunx` for other tools | Run command help or dry-run |

## Concrete Examples

Should trigger `agent-instructions`:

- "Write a skill for reviewing Svelte accessibility in this repo."
- "Improve the yjs skill description so it triggers less often."
- "Should this AGENTS.md rule become a skill or stay global?"

Should not trigger `agent-instructions`:

- "Install the TypeScript skill globally."
- "Write a README for the auth package."
- "Commit the current staged changes."

Imported-skill audit prompt:

```txt
Audit this third-party skill before adapting it to Epicenter. Check frontmatter,
scripts, network assumptions, npx commands, unsupported metadata, and conflicts
with AGENTS.md.
```

Small good skill shape:

```md
---
name: svelte-accessibility-review
description: Review Epicenter Svelte UI for accessibility and interaction issues. Use when reviewing `.svelte` UI, keyboard behavior, focus states, labels, or @epicenter/ui composition.
---

# Svelte Accessibility Review

Use `@epicenter/ui` components before custom controls.

Workflow:
1. Read the changed `.svelte` files.
2. Check keyboard access, focus order, labels, disabled states, and loading states.
3. Verify text does not overlap or rely on color alone.
4. Report findings first with file links.

Read `references/dialogs.md` when the change touches modal or popover focus.
```

## Execution Trace Review

Read traces and intermediate notes when behavior is subtle. Look for:

- What the agent loaded.
- What it ignored.
- Where it hesitated or explored unproductive paths.
- Where the skill caused overuse or false positives.
- Where it missed a project convention.
- Which instruction was too vague, too broad, or not needed.

If the agent already handles the task well without the skill, cut the skill or narrow it.

## Iteration Loop

Three rules decide what an iteration changes:

- Wrong skill loaded: revise the description. Right skill, wrong work: revise
  the body. Editing the body to fix a routing failure changes nothing.
- Adding an instruction is a hypothesis about behavior, so run the ablation as
  well as the addition: take the instruction back out and measure again. The
  gate arms in [Routing Surfaces](#routing-surfaces) are that ablation, and they
  are the reason the shortest plausible edit turned out not to be free.
- Keep the version with the best validation behavior, even when it is not the
  latest draft. The newest edit is not evidence.
- Do not add exhaustive rules to chase one failed prompt. Generalize only from
  repeated failures or a clear project constraint.

## Security And Portability

Audit imported or copied skills before installing or adapting them:

- Read `SKILL.md` and every linked file.
- Inspect scripts, dependencies, bundled assets, and templates.
- Look for hidden network assumptions or instructions that contact external services.
- State required tools as prerequisites. A skill does not grant access to apps, files, connectors, or credentials.
- Skills can only instruct agents to use tools and connectors already available under current permissions and organization controls.
- Avoid ChatGPT-only, Claude-only, or Codex-only behavior unless the user explicitly targets that tool.
- When installing skills across agents, prefer symlink installs so there is one source of truth. Use copy mode only when symlinks are impossible, and verify installed state with `skills list` when installation is part of the task.
- Prefer Vercel CLI behavior over local validators.

An imported skill often arrives carrying its origin host's extras. `SKILL.md`
lists which ones to strip and why.
