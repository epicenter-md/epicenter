---
name: dialectic
description: "Co-create an explicitly accepted, uncompromising destination before planning or implementation. Use when the user wants to discover what they actually want, asks for an uncompromising vision, wants iterative synthesis and pushback, is exploring an architecture or product model before a plan exists, or says to use dialectic. Do not use for interrogating an existing plan, comparing one bounded implementation choice, or ordinary implementation with a settled destination."
---

# Dialectic

Dialectic owns convergence before a plan exists. The agent presents a positive
synthesis; the user reacts freely; the agent treats that reaction as directional
data and presents a sharper synthesis. Success is explicit recognition of the
destination, not exhaustion, compromise, or a long list of answered questions.

```txt
positive synthesis
-> user reaction
-> directional data
-> revised synthesis under pressure
-> explicit acceptance
```

## Compose With

- Use [one-sentence-test](../one-sentence-test/SKILL.md) to compress a fuzzy
  destination once the model is substantially right.
- Hand an accepted destination to
  [greenfield-clean-breaks](../greenfield-clean-breaks/SKILL.md) when the current
  system must be worked backward into owner changes, deletion waves, and
  asymmetric refusals.
- Use [grill-me](../grill-me/SKILL.md) instead when a plan already exists and the
  job is to interrogate its decision tree.
- Use [co-design](../co-design/SKILL.md) for UI-specific product design that must
  become a buildable interface.

## Establish The Frame

Start from the desired product or system, not the inherited implementation.
Separate constraints before synthesizing:

```txt
Hard constraints:
  user outcomes, safety, security, durable data, external reality, explicit
  promises the user chooses to preserve

Suspended constraints:
  current APIs, names, compatibility paths, package boundaries, prior plans,
  helper shapes, and implementation effort
```

Inspect the repository when facts affect feasibility or reveal a real product
promise. Do not let the current code supply the first model or quietly convert
an inherited choice into a hard constraint.

## Present A Positive Synthesis

Do not open with a questionnaire or make the user design the answer. Lead with
the clearest model you can now see:

```txt
Current read:
  What I think the user is reaching for.

Uncompromising vision:
  The cleanest model with inherited constraints suspended.

Why this model:
  The important distinction it clarifies and the value it preserves.

Tradeoffs and refusals:
  What this direction deliberately gives up or makes impossible.

Pressure point:
  The strongest unresolved consequence, counterexample, or fork.

Recommendation:
  The direction I recommend now, stated plainly.
```

Offer multiple options only when a real fork remains. Recommend one. A menu of
equally weighted ideas gives the synthesis work back to the user.

Use the labels only when they improve clarity. After the first round, do not
repeat the full template. Keep the exchange conversational: show the revised
model, what materially changed, and the next pressure point.

## Read Reactions As Directional Data

The user may approve one clause, reject a distinction, challenge a tradeoff,
offer an analogy, contradict themselves, or ramble. Extract the signal without
requiring them to restate it formally:

```txt
Preserve:
  language, outcomes, or principles that produced recognition

Reject:
  assumptions, distinctions, or consequences that felt wrong

Intensify:
  values the user cares about more strongly than the prior synthesis showed

Resolve:
  tensions or ambiguities the reaction exposed
```

Do not merely paraphrase the reaction. Revise the model, say what materially
changed, and show the consequence of that revision.

## Revise And Apply Pressure

Each round should do three things:

1. Preserve the parts that earned clear recognition.
2. Replace the weakest assumption with a sharper positive synthesis.
3. Pressure-test one important implication, edge case, refusal, or competing
   principle.

Keep the live model small enough to hold in the user's head. Prefer one strong
distinction per round. Ask a question only when its answer would materially
change the synthesis, and still provide your recommended answer for the user to
react to.

If the loop stalls, name the exact unresolved fork, state what evidence would
resolve it, and recommend a side. A prototype or repository investigation may
provide evidence, but neither substitutes for acceptance.

## Acceptance Gate

Do not infer convergence from silence, fatigue, partial approval, or the absence
of another objection. The destination is accepted only when the user explicitly
recognizes the whole model as what they want. Approval with a caveat starts
another revision round.

Once accepted, freeze a compact destination artifact:

```txt
Accepted destination:
  One concrete product or system sentence.

Mental model:
  The central objects, verbs, boundaries, and owner.

Hard constraints:
  What must remain true.

Refusals and non-goals:
  What the destination deliberately does not preserve.

Consequences:
  The most important tradeoffs the user accepted.
```

If this cannot stay succinct, run the one-sentence test and continue the loop.
Do not begin backward planning while the destination still contains competing
models hidden behind "or", "also", "sometimes", or compatibility language.

## Transition

After explicit acceptance:

```txt
Thinking-only request:
  Return the accepted destination and stop.

Existing-system replacement:
  Load greenfield-clean-breaks, bring the current system back into view, and
  work backward through owner changes, deletion waves, verification, and old
  path removal.

Durable architectural decision:
  Preserve the settled decision and rationale in an ADR at the appropriate
  point in the repository workflow.
```

Do not implement early to create artificial momentum. Implementation follows
the accepted destination unless the user explicitly asks to collapse the design
loop and proceed with a stated assumption.

## Completion Check

Before handing off, confirm:

```txt
Did I present a positive synthesis rather than only questions?
Did the user's reactions materially change or strengthen the model?
Did I expose the real tradeoffs and pressure-test the strongest implication?
Did the user explicitly accept the complete destination?
Can the accepted destination fit in one concrete sentence?
Is the next move clearly thinking-only, clean-break execution, or ADR capture?
```
