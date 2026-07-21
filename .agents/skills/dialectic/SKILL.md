---
name: dialectic
description: "Bring the agent's grounded working model of a subject into contact with the user's partially expressed ideal to construct a live shared model before planning or implementation. Use when the user wants to discover what they actually want, asks for an uncompromising vision, wants iterative synthesis and pushback, is exploring an architecture or product model before a plan exists, or says to use dialectic. Do not use for interrogating an existing plan, comparing one bounded implementation choice, or ordinary implementation with a settled destination."
---

# Dialectic

A dialectic brings a grounded model of what is and could be into contact with
an ideal model of what should be, producing a live shared model of what should
be true, why it can be true, and what it requires.

```txt
agent's grounded working model                 --.
(what is and could be)                            \
                                                    +--> live shared model <--> further conversation
user's ideal model                               /
(what should be, often partly expressed)       --'
```

The agent brings the best model it can ground in the available code, context,
documentation, external sources, and prior conversation. That model can
describe what exists, explain why it has its current shape, and propose what
could follow. These are claims within one grounded model, not separate routes.
The user brings the model of what should exist, often through goals, questions,
reactions, examples, analogies, and refusals rather than a complete design.

Conversation brings these models into contact. Explanation exposes reasoning.
Questions locate the edge of shared understanding and help construct what
comes next. Reactions reveal the shape and texture of the user's ideal.
Synthesis makes the resulting model available for both participants to change.
Do not treat these as separate phases.

## Compose With

- Use [one-sentence-test](../one-sentence-test/SKILL.md) to compress the shared
  model once it is substantially coherent.
- Hand a settled destination to
  [greenfield-clean-breaks](../greenfield-clean-breaks/SKILL.md) when the
  current system must be worked backward into owner changes, deletion waves,
  and asymmetric refusals.
- Use [grill-me](../grill-me/SKILL.md) instead when a plan already exists and
  the job is to interrogate its decision tree.
- Use [ui-design](../ui-design/SKILL.md) for UI-specific product design that
  must become a buildable interface.

## Ground The Working Model

Gather enough evidence to make the working model honest. Separate what the
sources establish from the agent's interpretation, assumptions, and proposed
consequences. A proposal remains grounded when the path from present evidence
to proposed possibility is explicit and inspectable.

Inspect the repository when facts affect the model, feasibility, or a real
product promise. Use external sources when outside behavior affects
correctness. Let evidence constrain claims about reality without quietly
turning inherited choices into requirements for the destination.

Treat authority asymmetrically:

```txt
Available evidence       observed facts, durable promises, external constraints
The agent                a coherent account of structure and possibility
The user                 desired outcomes, taste, and accepted losses
The live shared model    the current mutually visible synthesis
```

Suspend current APIs, names, compatibility paths, package boundaries, prior
plans, helper shapes, and implementation effort unless external reality or an
explicit user promise makes one of them a hard constraint.

## Build The Live Shared Model

Begin with the clearest model available, not a questionnaire. Explain enough
of its structure that the user can follow how its premises produce its
consequences, then expose the most important difference between that model and
the ideal you infer from the user.

Keep the live shared model small enough to remain present in the conversation.
It should make visible:

```txt
Grounding:
  The facts, constraints, causal structure, assumptions, and possibilities.

Ideal:
  The ideal the user appears to be reaching for.

Synthesis:
  The best current account of what should be true, why it can be true, and
  what it requires.

Tension:
  The consequential mismatch, uncertainty, or refusal still under pressure.

Settled:
  Principles, distinctions, consequences, and refusals both recognize.
```

Do not mechanically print this ledger every turn. Make its important movement
visible, and continue from the shared model rather than restarting from either
participant's private interpretation.

## Make Every Turn Reconcile The Models

Each response should make the current model more inhabitable while creating an
opening through which the user can change it:

1. Explain the part of the agent's model the user needs in order to reason
   forward. If the user asks why or how, treat that as evidence of a missing
   connection, not a detour from the dialectic.
2. Interpret the user's answers, questions, examples, and reactions as partial
   expressions of their ideal. Preserve their texture when formalizing it
   would erase a meaningful distinction.
3. Update the live shared model. Say what changed and what now follows; do not
   merely paraphrase the latest message.
4. Apply pressure to one important mismatch, implication, edge case, refusal,
   or competing principle.
5. Ask a question only when its answer could change or deepen the model. Give
   the agent's recommended answer so the user has something concrete to
   question or react to.

The user does not need a response format or a formal teach-back. They may catch
up by asking about the working model, teach the agent through reactions and
examples, revise their own ideal after seeing a consequence, or do several of
these at once. Meet the move they actually made while continuing to steward
the shared model.

Offer multiple options only when the shared model contains a real fork.
Recommend one. A menu of equally weighted ideas gives the synthesis work back
to the user.

## Reconcile Without Compromise

Reconciliation does not mean averaging the models. The agent's working model
may be rejected. The user's initial ideal may change when previously hidden
consequences become visible. A durable constraint may rule out both.

Resolve differences by finding the premise, value, distinction, or consequence
that makes the models diverge. Preserve disagreement while it remains real.
Do not hide competing models behind "or", "also", "sometimes", or compatibility
language merely to produce agreement.

If the conversation stalls, state the exact divergence, explain what evidence
or decision would resolve it, and recommend a side. Repository investigation
or a prototype may supply missing evidence, but neither substitutes for the
user recognizing the resulting destination.

## Convergence Gate

The dialectic has converged when the live shared model is generative: both
participants can reason forward from it, anticipate its important
consequences, and recognize what would violate it. They do not need identical
private models or matching words.

Do not infer convergence from silence, fatigue, partial approval, or the
absence of another objection. Ask the user to recognize the complete model,
including its important refusals and consequences. A consequential mismatch or
caveat starts another round.

Once recognized, freeze the live model into a compact destination artifact:

```txt
Accepted destination:
  One concrete product or system sentence.

Mental model:
  The central objects, verbs, boundaries, and owner.

Hard constraints:
  What must remain true because of desired outcomes or external reality.

Refusals and non-goals:
  What the destination deliberately does not preserve.

Consequences:
  The important tradeoffs and implications the user accepted.
```

If the artifact cannot stay succinct, run the one-sentence test and continue
the dialectic.

## Transition

After convergence:

```txt
Thinking-only request:
  Return the accepted destination and stop.

Existing-system replacement:
  Load greenfield-clean-breaks, bring the full current system back into view,
  and work backward through owner changes, deletion waves, verification, and
  old-path removal.

Durable architectural decision:
  Preserve the settled decision and rationale in an ADR at the appropriate
  point in the repository workflow.
```

Do not implement early to create artificial momentum. Implementation follows
the accepted destination unless the user explicitly asks to collapse the
design loop and proceed with a stated assumption.

## Completion Check

```txt
Did I ground the working model and expose the path from evidence to proposal?
Did I make the reasoning inhabitable rather than only state conclusions?
Did the user's questions and reactions materially update the shared model?
Did I expose and pressure the most important divergence or consequence?
Can both participants reason forward from the resulting model?
Did the user explicitly recognize its destination, refusals, and consequences?
Is the next move clearly thinking-only, clean-break execution, or ADR capture?
```
