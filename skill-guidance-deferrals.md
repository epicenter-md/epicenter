# Skill Guidance Deferrals

Text this wave removed from Epicenter, or found at risk outside it, that is
worth a second look before it is gone for good. Each entry carries where it came
from, the exact words, why it did not stay, and what would make it worth
reviving.

Nothing here is a decision waiting to be made. Every entry was decided against
on the evidence available; the entries exist so a later, better-informed pass
can reverse one without rediscovering it. The natural destination is
`~/Code/vault`, not this repository. **Delete this file once it has been
harvested.**

---

## 1. Codex's system `skill-creator` is about to be overwritten

**Source:** `~/.codex/skills/.system/skill-creator/SKILL.md`, hand-rewritten
2026-08-01 13:49. Not under version control.

**At risk because:** Codex installs and rewrites `~/.codex/skills/.system/`.
Three things establish it, measured against `codex-cli 0.145.0` at
`~/.local/bin/codex`:

- The binary carries the code paths `write system skill file`,
  `create system skills dir`, and `failed to install system skills`, and the
  directory holds a `.codex-system-skills.marker` (`6fac8acc0c6abb7b`) the hand
  edit did not touch.
- The binary carries the file manifest it writes, including
  `skill-creator/SKILL.md`, `skill-creator/license.txt`, and the bundled
  `init_skill.py` and `quick_validate.py`.
- The binary also carries the *original* prose for that SKILL.md, in sections
  titled `Progressive Disclosure Design Principle` and
  `What to Not Include in a Skill`. None of the hand-written headings
  (`Find The Actual Gap`, `Steer, Do Not Substitute`) appear anywhere in it.

So the on-disk file is a local divergence from a copy Codex still holds and will
write back. Recover the upstream text at any time with
`strings -a ~/.local/bin/codex`.

**Why not carried into Epicenter:** these are general authoring craft, not
knowledge that is irreducible to this repository. Merging them into
`agent-instructions` would put back the kind of universal advice this wave took
out. Their home is a personal cross-project skill in `~/Code/dotfiles`, which is
the established rule for guidance that should follow you between repositories.

**Exact text worth keeping.** The gap taxonomy, which is the sharpest thing in
the file and has no equivalent in Epicenter:

> Ask what is missing:
>
> - **No stable gap:** Do not add a skill.
> - **Local knowledge:** Add a focused reference, schema, policy, or glossary.
> - **Outcome, authority, or decision boundary:** Add compact steering.
> - **Fragile, repetitive, or deterministic work:** Add a tested script or tool contract.
> - **Required output material:** Add an asset or template.
>
> Use the narrowest intervention that closes the demonstrated gap. Prefer a
> reference for facts, a script for mechanics, and prose for judgment. Do not use
> prose to simulate either a reference or a script.

One sentence that names a failure mode nothing in Epicenter names:

> Do not turn one successful trajectory into a permanent procedure.

And the maintenance rule, which matters more as models change than when it was
written:

> Revisit existing skills when the target model, tools, or environment changes.
> A former workaround can become redundant context or an unintended constraint.
> Preserve the underlying requirement, but remove scaffolding that no longer
> earns its place.

**Revive when:** you want a personal `skill-creator` that survives Codex
updates. Put these three pieces in `~/Code/dotfiles`, not in `.system/`, and not
in Epicenter.

**Deliberately not carried over:** everything in that file's `Package The Skill`
section, which mandates `agents/openai.yaml` plus the `init_skill.py` and
`quick_validate.py` scripts bundled beside it. Those are the host adapter,
scaffold, and local format validator that
`.agents/skills/agent-instructions/SKILL.md` now refuses by name.

**Already carried over:** the ablation step, which this wave merged into
`references/evaluation.md` because the gate arms are an instance of it.

---

## 2. Four-way skill classification

**Source:** `.agents/skills/agent-instructions/SKILL.md` and
`references/evaluation.md`, both removed in `docs(skills): trade the drafting
templates for what only this repo knows`.

**Exact text:**

> Classify the skill as `process`, `tool workflow`, `convention`, or `domain pattern`.

> Classify the skill as a process, tool workflow, convention, or domain pattern.
> If one skill needs multiple classifications with different trigger situations,
> consider splitting it.

**Why deferred:** the classification had no downstream consequence. Nothing in
the skill, its references, or its scripts read the label. The one rule attached
to it, split when a skill spans classifications, restates a sharper rule the
`Decide Update Or New` section already owns: split when workflows are mutually
exclusive, when the description turns broad or ambiguous, or when a reference
would load for the wrong jobs.

**Revive when:** a split decision is genuinely hard and the existing three
criteria fail to settle it. If the taxonomy earns a place, it needs a consumer:
something that reads the label and behaves differently.

---

## 3. Skill Content Checklist

**Source:** `.agents/skills/agent-instructions/references/evaluation.md`, removed
in the same commit.

**Exact text:**

> Before expanding a draft, confirm the skill states:
>
> - Job to be done.
> - Required inputs or prerequisites.
> - Ordered workflow.
> - Output format or final artifact.
> - Guardrails and forbidden actions.
> - Final checks.

**Why deferred:** it is a document outline, and the wave's destination is that a
skill equips a capable agent rather than handing it a template. An agent that
has to be told a skill contains a workflow cannot write one.

**Revive when:** a measured comparison shows skills written without it are
missing something that matters. That is a real experiment: author two skills for
the same gap, one with the checklist in context and one without, and grade the
outputs. Absent that evidence, the checklist is ceremony.

---

## 4. Nine-step iteration loop and seven-step drafting and update procedures

**Source:** `.agents/skills/agent-instructions/SKILL.md` (`Before drafting body
content:` 1-7 and `When updating an existing skill:` 1-7) and
`references/evaluation.md` (`## Iteration Loop` 1-9). All removed in the same
commit; recover the full text with `git show`.

**Why deferred:** the load-bearing steps survived as rules. Description before
body, ask rather than invent, check whether references still earn their keep,
strip outgrown scaffolding, revise the description for a routing failure and the
body for an execution failure, keep the version with the best validation
behavior. The rest was procedure an agent follows without being asked: read the
current file, run realistic prompts, record failures, group patterns, re-run
validation.

**Revive when:** a trace shows an agent actually skipping one of the dropped
steps in a way that cost something. Ordering advice is cheap to add back one
line at a time and expensive to carry as a list.

---

## 5. Script requirements bullet list

**Source:** `.agents/skills/agent-instructions/references/evaluation.md`, removed
in the same commit. Nine bullets covering relative paths, listing in `SKILL.md`,
self-containment, non-interactivity, `--help`, stdout and stderr split, exit
codes, idempotency, and bounded output.

**Why deferred:** `SKILL.md` already carries the same requirements in one
sentence, so the list was a second copy that could drift. The two items the
sentence did not carry, idempotency and the Bun inline-dependency trap, were kept
in place.

**Revive when:** a script lands that violates one of the dropped bullets in a way
the one-sentence version did not warn about. The failure names the missing
bullet.
