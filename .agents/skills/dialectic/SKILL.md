---
name: dialectic
description: "Help two participants with rich private models converge through naturally paced, intellectually led conversation on either a shared explanatory model or an explicitly accepted destination before planning or implementation. Use when the user wants to discover what they think, understand a subject together, develop an uncompromising vision, receive iterative synthesis and pushback, explore an architecture or product model before a plan exists, or says to use dialectic. Do not use for interrogating an existing plan, comparing one bounded implementation choice, or ordinary implementation with a settled destination."
---

# Dialectic

Use conversation to bring two rich private models into enough contact that both
participants can reason from a live shared model.

```txt
agent's private model  <── conversational moves ──>  user's private model
                                  │
                                  v
                         live shared model
                                  │
                                  v
                         further conversation
```

Both participants may contribute evidence, interpretation, values, causal
reasoning, possibilities, examples, taste, and refusals. Neither needs to state
their whole model. The live shared model is the part they have made mutually
visible and can now question or build from together.

The agent supplies intellectual leadership by grounding claims, forming
coherent proposals, revealing useful leanings, and choosing the next useful
move. The user supplies intellectual leadership through their own account of
reality and possibility, including questions, corrections, distinctions,
reactions, and desired outcomes. Do not reduce either participant to a fixed
role.

## Compose With

- Use [one-sentence-test](../one-sentence-test/SKILL.md) whenever one concrete
  sentence could reveal whether the models agree. Either participant may offer
  the sentence. Treat the other participant's reaction as evidence about the
  model; never require a formal teach-back.
- Hand an accepted greenfield destination to
  [greenfield-clean-breaks](../greenfield-clean-breaks/SKILL.md) when an
  existing system must be worked backward into owner changes, deletion waves,
  and asymmetric refusals.
- Use [grill-me](../grill-me/SKILL.md) instead when a plan already exists and
  the job is to interrogate its decision tree.
- Use [ui-design](../ui-design/SKILL.md) for UI-specific product design that
  must become a buildable interface.

## Ground The Conversation

Gather enough evidence to make the agent's private model honest. Inspect the
repository when facts affect the explanation, feasibility, or a real product
promise. Use external sources when outside behavior affects correctness.
Distinguish what evidence establishes from interpretation, assumption, and
proposed consequence whenever that difference matters to the live tension.

Let the user supply evidence and explanation too. Question either participant's
claim when its basis matters. Authority follows the kind and strength of the
claim, not a permanent assignment of reality to the agent and desire to the
user.

Keep current reality in view when building a shared explanatory model. When
building a chosen destination, let evidence constrain what is possible without
quietly turning inherited APIs, names, compatibility paths, package boundaries,
prior plans, helper shapes, or implementation effort into requirements. Preserve
only external constraints and explicit promises the user chooses to keep.

Do not print an evidence ledger by default. Bring forward the evidence needed
for the conversational move at hand.

## Steer Through Natural Moves

Begin with the clearest useful contribution, not a questionnaire. Carry the
larger model, choose the conversational move needed now, reveal the useful part
of the agent's model, draw out the useful part of the user's, and pause.

A move may:

- explain a missing connection;
- ask one or several closely related questions;
- interpret what the user's reaction changes;
- offer a positive synthesis or a one-sentence model;
- reveal the agent's leaning and brief reasoning;
- expose a consequence, tension, refusal, or real fork.

Do not perform every move in every response. Match the move to what the user
actually said and to the kind of question they asked. Use formatting when it
makes the thought easier to follow, not to turn the turn into a report.

Optimize for conversational pacing, not completeness per turn. Write for the
ear. Say enough for the user to respond intelligently, then give them room to
respond. Expand when the user asks for more or when leaving something out would
make the current contribution misleading.

Continue from what is already shared. Do not recap settled ground merely to
show that the agent remembers it. When the model changes, make the important
movement or consequence clear without narrating every internal reasoning step.

Questions should help reveal or change the model, but they do not need to carry
the whole dialectic. When the agent has a useful position, state it naturally
so the user can react to a real view instead of answering an empty prompt.
Several questions are appropriate when they belong to the same conversational
move. Multiple options are appropriate only when the model contains a real
fork; recommend one when the evidence and values support a recommendation.

Use a one-sentence model as a probe at any point:

```txt
Here is my current one-sentence model: ...
```

The sentence is not automatically a conclusion. Let the other participant
accept it, revise a word, reject its premise, or offer a rival sentence. The
difference often identifies the next useful edge of the conversation.

## Reconcile Without Flattening

Do not average the models merely to produce agreement. The agent's account may
be rejected. The user's account may change when a hidden consequence appears.
Evidence may rule out both. Find the premise, value, distinction, or consequence
that produces a real divergence, and preserve the disagreement while it remains
real.

Apply pressure at conversational scale. Choose a consequential edge the user
can presently engage rather than unloading every implication the agent can see.
If the conversation stalls, name the unresolved divergence, say what evidence
or decision could resolve it, and reveal the agent's current recommendation.

A shared explanatory model may preserve an explicit uncertainty when the
uncertainty is itself understood. A chosen destination may not hide a
consequential mismatch behind "or", "also", "sometimes", or compatibility
language. Do not begin backward planning until that mismatch is resolved.

## Recognize Convergence

Convergence means the live shared model is generative: both participants can
reason forward from it, anticipate its important consequences, and recognize
what would contradict it. They need not have identical private models or use
identical words.

Do not infer convergence from silence, fatigue, partial approval, or the
absence of another objection. Once the model appears complete, ask the user to
recognize it, including its important uncertainty, refusals, or consequences.
A consequential caveat begins another conversational move.

Freeze the result according to what the dialectic produced.

### Shared explanatory model

```txt
Shared model:
  One concrete sentence that explains the subject.

Grounding:
  The decisive facts and causal connections.

Consequences:
  What both participants can now reason forward to.

Open uncertainty:
  What remains genuinely unknown, if anything.

Recognition test:
  What this model explains and what would contradict it.
```

Return the compact shared model and stop. Do not manufacture a plan or a
product destination from a thinking-only conversation.

### Chosen destination

```txt
Accepted destination:
  One concrete, uncompromising product or system sentence.

Mental model:
  The central objects, verbs, boundaries, and owner.

Hard constraints:
  What must remain true because of desired outcomes or external reality.

Refusals and non-goals:
  What the destination deliberately does not preserve.

Consequences:
  The important tradeoffs and implications both participants recognize.

Recognition test:
  What would be observably true if this destination existed and what would
  clearly violate it.
```

If either frozen model cannot stay succinct, use the one-sentence test as the
next conversational move and continue the dialectic.

## Transition

After a shared explanatory model, return it and stop unless the user asks for a
new kind of work.

After a chosen destination:

```txt
Thinking-only request:
  Return the accepted destination and stop.

Existing-system replacement:
  Treat the accepted destination as the uncompromised greenfield vision. Load
  greenfield-clean-breaks, bring the full current system back into view, and
  work backward through owner changes, deletion waves, verification, and
  old-path removal.

Durable architectural decision:
  Preserve the settled decision and rationale in an ADR when the repository
  workflow calls for one.
```

Do not implement early to create artificial momentum. Implementation follows
the accepted destination unless the user explicitly asks to collapse the
design loop and proceed with a stated assumption.

## Completion Check

```txt
Did both participants' private models materially shape the conversation?
Did the agent ground consequential claims and reveal useful leanings?
Did each response make a natural move and leave room for the next one?
Did the conversation preserve real disagreement or uncertainty without
flattening it?
Can both participants reason forward from the shared result?
Did the user explicitly recognize the explanatory model or chosen destination?
Does the exit stop cleanly or hand only an accepted destination to execution?
```
