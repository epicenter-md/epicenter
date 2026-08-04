---
name: skill-creator
description: Guide for creating and improving effective skills. Use when users want to create a new skill or update an existing skill that equips Codex with non-obvious domain knowledge, reliable procedures, or tool integrations.
---

# Skill Creator

A skill equips and steers an agent for a particular environment. It does not replace the agent's ordinary judgment, planning, exploration, implementation choices, or routine recovery.

Start from the work that must become true, the context the agent cannot reliably infer, and the boundaries that are real. Give the agent the smallest useful addition. Do not turn one successful trajectory into a permanent procedure.

## Find The Actual Gap

Begin with representative requests and clear evidence of success. Run the work, inspect traces or artifacts, and identify a stable gap before authoring a skill. A different but valid approach is not a failure.

Ask what is missing:

- **No stable gap:** Do not add a skill.
- **Local knowledge:** Add a focused reference, schema, policy, or glossary.
- **Outcome, authority, or decision boundary:** Add compact steering.
- **Fragile, repetitive, or deterministic work:** Add a tested script or tool contract.
- **Required output material:** Add an asset or template.

Use the narrowest intervention that closes the demonstrated gap. Prefer a reference for facts, a script for mechanics, and prose for judgment. Do not use prose to simulate either a reference or a script.

## Steer, Do Not Substitute

Assume Codex can inspect its environment, make ordinary in-scope decisions, choose an implementation path, recover from routine errors, and validate its work. A skill should state only what changes those decisions:

- the outcome and product requirement that matter;
- non-obvious local context;
- hard constraints and authority boundaries;
- when an important ambiguity must be surfaced;
- the evidence required before the work is complete.

Keep each instruction at the narrowest scope that solves its problem, and state it once. Do not add speculative guardrails, repeated reminders, exhaustive edge-case lists, or step-by-step procedures merely because they appeared in a successful run.

Use low-freedom instructions only when a sequence is genuinely safety-critical, irreversible, fragile, or deterministic. Otherwise, describe the destination and the boundary, then leave the route to the agent.

For example, prefer:

```text
Use the published schema as the source of truth. Ask before changing a durable
external contract. Include the migration and validation evidence in the handoff.
```

over a long sequence of ordinary inspection, editing, and testing steps. Make an exact sequence explicit only when correctness actually depends on its order.

## Give Context The Right Shape

Context is finite. Put the rule where the decision occurs, put the fact where it can be looked up, and put a procedure in code when code can perform it more reliably than prose.

Skills have progressive disclosure:

1. **Metadata:** `name` and `description` determine discovery. Write the description so Codex can recognize both what the skill does and the requests that should trigger it.
2. **SKILL.md:** Keep the load-bearing steering and clear pointers to bundled material.
3. **Resources:** Load detail only when the task needs it.

Keep `SKILL.md` concise and under 500 lines. When detail grows, split it into direct, one-level-deep references. Keep mutually exclusive variants separate so the agent loads only the relevant path.

Use resources deliberately:

- **`scripts/`:** Deterministic, repeatable, or error-prone operations. Say clearly whether Codex should run a script or read it as reference. Test every added script.
- **`references/`:** Domain facts, schemas, policies, API material, and detailed variant guidance. Keep core instructions out of the reference and detailed facts out of the core skill.
- **`assets/`:** Files used in the work product, such as templates, icons, fonts, or starter projects. Do not load assets into context as documentation.

Do not create auxiliary process documentation such as a README, changelog, quick reference, or installation guide. A skill contains only what an agent needs to do the work.

## Write A Natural Operating Contract

Write to a capable collaborator. Lead with what should become true, point to the context worth seeing, and name the boundaries that are real. Avoid a governance document, a pre-chosen plan, or a menu of ordinary decisions for the agent to make later.

Use direct, imperative language. Prefer concrete terms over labels such as “be careful” or “use good judgment.” When a rule depends on conditions, name the condition and the action. When the agent needs an example, use a small, canonical example that expresses a product requirement or closes a measured gap. Do not collect examples as a substitute for a decision rule.

For long-horizon work, give the agent a lightweight way to recover key decisions, unresolved questions, and proof. Do not preload every historical detail when file paths, queries, or references can be discovered just in time.

## Evaluate, Ablate, And Maintain

Every material instruction, example, resource, and tool is a hypothesis about agent behavior. Test it on representative work:

1. Establish a baseline without the proposed addition.
2. Add the smallest targeted intervention.
3. Re-run the same work and inspect the required evidence.
4. Remove or weaken the intervention and run the comparison again when practical.
5. Keep it only when it improves the required result, reduces a real risk, or encodes a non-negotiable requirement.

For complicated skills, forward-test with a fresh agent. Give it the task and the raw artifacts it needs, not the intended answer, suspected failure, or proposed fix. Review its output, traces, and artifacts as evidence rather than assuming success proves generality.

Revisit existing skills when the target model, tools, or environment changes. A former workaround can become redundant context or an unintended constraint. Preserve the underlying requirement, but remove scaffolding that no longer earns its place.

## Package The Skill

Every skill has a required `SKILL.md` and may have only the resources it needs:

```text
skill-name/
├── SKILL.md
├── agents/
│   └── openai.yaml
├── scripts/
├── references/
└── assets/
```

Use a lowercase hyphenated name of fewer than 64 characters. Prefer a short verb-led name. Name the folder exactly after the skill.

The YAML frontmatter must contain only `name` and `description`. Put all trigger guidance in the description because Codex reads it before it loads the body.

Use `agents/openai.yaml` for the skill-list interface. Read [references/openai_yaml.md](references/openai_yaml.md) before creating or changing it. Generate it deterministically with `scripts/generate_openai_yaml.py`, passing `--interface key=value` for `display_name`, `short_description`, and `default_prompt`. Regenerate it when the skill changes materially.

For a new skill, ask where to create it. If the user has no preference, use `${CODEX_HOME:-$HOME/.codex}/skills`. Initialize it with:

```bash
scripts/init_skill.py <skill-name> --path <output-directory> [--resources scripts,references,assets]
```

Do not create empty resource directories or leave example placeholders behind.

Validate every completed skill:

```bash
scripts/quick_validate.py <path/to/skill-folder>
```

Fix validation failures, then run the smallest representative proof appropriate to the skill's risk.
