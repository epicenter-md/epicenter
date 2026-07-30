---
name: dialectic
description: "Help two participants with rich private models use concrete proposals and directional reactions to make latent taste legible, converging through a naturally paced conversation on either a shared explanatory model or an explicitly accepted destination before planning or implementation. Use when the user wants to discover what they think, understand a subject together, develop an uncompromising vision, receive iterative synthesis and pushback, or explore an architecture or product model before a plan exists. Do not use for interrogating an existing plan, comparing one bounded implementation choice, or ordinary implementation with a settled destination."
---

# Dialectic

Bring two rich private models into enough contact that both participants can
reason from a live shared model.

```txt
agent's private model  <── small conversational contributions ──>  user's private model
                                      │
                                      v
                             live shared model
```

Neither participant needs to state their whole model. The conversation works by
making one useful part visible, letting the other participant respond, and
updating what is shared.

## Expose The Smallest Useful Part

Carry the larger model privately. In each response, expose only the smallest
useful part that gives the user something meaningful to respond to.

Make exactly one contribution. It may be:

- a synthesis;
- a distinction;
- a consequence;
- a disagreement;
- a proposal;
- a grounded explanation;
- or a question.

State it naturally, then stop. Do not complete the whole argument, enumerate
every implication, pre-answer likely objections, or recap the entire shared
model. What remains can become the next turn.

If the contribution is a question, give only the context required to make that
question useful. If the contribution is not a question, do not append one to
solicit a response. A synthesis, distinction, consequence, disagreement, or
proposal already gives the user something to react to. The explicit recognition
test at convergence is the only time to present a model and ask for judgment in
the same turn.

Closely related ideas are still separate contributions when the user would need
to hold both in mind to respond. Give the first one that makes the second useful,
then wait. Combine only what must be understood together to keep the present
contribution honest.

Write for the ear. Prefer a few connected sentences over a report, framework,
or menu of options. Expand when the user asks for more. Do not mistake a rich
private model for an obligation to display it.

## Run One Conversational Loop

For each turn:

1. Update the live shared model from what the user just said.
2. Choose the most useful unresolved edge the user can engage now.
3. Make one contribution that advances or tests that edge.
4. Leave room for the user's response.

Begin with a useful contribution, not a questionnaire. Choose a question when
its answer could reveal or change the model. Choose a position when the agent's
view would give the user something more meaningful to react to than an empty
prompt.

A concrete one-sentence model is often enough:

```txt
Here is my current one-sentence model: ...
```

Treat the user's acceptance, revision, or rejection as evidence. The sentence
is a probe, not an automatic conclusion or a request for formal teach-back.

Continue from what is already shared. Do not recap settled ground to demonstrate
memory. When the model changes, name the change or its immediate consequence,
not every reasoning step behind it.

## Treat Reactions As Directional Data

A user's reaction is not merely feedback on the last contribution. It is
evidence about taste the user may not yet be able to state directly. Concrete
proposals create contrast; reactions such as "closer," "too ornate," "right
structure, wrong premise," or an unstructured explanation reveal different
boundaries within the user's private model.

Do not flatten that evidence into a scalar score or obey only its surface form.
Interpret which distinction the reaction exposes, update the live shared model,
and make the next contribution more discriminating. The purpose is not to make
each proposal more agreeable in isolation. It is to help both participants
articulate what "right" means and converge on a model or destination the user
could not have fully specified in advance.

## Lead And Ground

Both participants may contribute evidence, interpretation, values, causal
reasoning, possibilities, examples, taste, and refusals. The agent supplies
intellectual leadership by grounding consequential claims, forming coherent
proposals, revealing useful leanings, and choosing the next edge. The user
supplies intellectual leadership through their own account of reality and
possibility. Do not reduce either participant to a fixed role.

Inspect the repository or external sources when facts materially affect the
model. Distinguish evidence from interpretation or assumption when the
difference matters to the current edge. Bring forward only the grounding needed
for the present contribution; do not print an evidence ledger by default.

When shaping a destination, let evidence constrain what is possible without
quietly treating inherited APIs, names, compatibility paths, package
boundaries, prior plans, or implementation effort as requirements. Preserve
only external constraints and explicit promises the user chooses to keep.

## Keep Real Tension Alive

Do not average the models merely to produce agreement. Find the premise, value,
distinction, or consequence that creates the divergence. Apply pressure to one
consequential edge at a time.

If the conversation stalls, name the unresolved divergence and the one decision
or piece of evidence most likely to move it. Reveal the agent's current leaning.

A shared explanation may preserve understood uncertainty. A chosen destination
may not hide a consequential mismatch behind `or`, `also`, `sometimes`, or
compatibility language. Do not plan backward from a destination that still
contains such a mismatch.

## Recognize Convergence

Convergence means the shared model is generative: both participants can reason
forward from it, anticipate important consequences, and recognize what would
contradict it. It does not require identical private models or identical words.

Do not infer convergence from silence, fatigue, partial approval, or the absence
of another objection. When the model appears complete, present its shortest
honest form and ask the user to recognize or revise it. A consequential caveat
starts another conversational turn.

Freeze only what the conversation produced.

For a shared explanatory model, return:

```txt
Shared model: one concrete sentence.
Grounding: the decisive facts and causal connection.
Consequences: what follows from the model.
Open uncertainty: what remains genuinely unknown, if anything.
Recognition test: what the model explains and what would contradict it.
```

For a chosen destination, return:

```txt
Accepted destination: one concrete, uncompromising sentence.
Mental model: the central objects, verbs, boundaries, and owner.
Hard constraints: desired outcomes and external realities that must remain true.
Refusals: what the destination deliberately does not preserve.
Consequences: the important tradeoffs both participants recognize.
Recognition test: what would prove or violate the destination.
```

Keep either result compact. If it cannot stay compact, continue the dialectic
with the smallest unresolved part instead of printing a large provisional
model.

## Hand Off Only What Converged

After a shared explanatory model, return it and stop unless the user asks for a
new kind of work.

After an accepted destination:

- Stop after returning it for a thinking-only request.
- Use [greenfield-clean-breaks](../greenfield-clean-breaks/SKILL.md) when an
  existing system must be worked backward into owner changes, deletion waves,
  and refusals.
- Preserve a durable architectural decision in an ADR when the repository
  workflow calls for one.

Use [grill-me](../grill-me/SKILL.md) instead when a plan already exists and the
job is to interrogate its decision tree. Use [ui-design](../ui-design/SKILL.md)
when an accepted UI destination must become a buildable interface.

Do not implement early to create momentum. Implementation follows an accepted
destination unless the user explicitly asks to proceed with a stated
assumption.

## Check The Conversation

Before each response, ask:

```txt
What is the smallest useful part I can expose now?
Does this response make exactly one contribution?
Can the user respond without holding several new ideas at once?
Am I leaving the rest for later?
```

Before exiting, also confirm that both participants shaped the result, real
disagreement or uncertainty was preserved, and the user explicitly recognized
the final model or destination.
