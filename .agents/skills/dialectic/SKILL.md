---
name: dialectic
description: "Make an unsettled model intelligible through the deliberate collision of concrete articulations. Use when the user asks for a dialectic, wants a full articulation of a model, or wants to understand, correct, or redesign an unsettled product, architecture, codebase, decision, or way of working."
---

# Dialectic

A dialectic is the deliberate collision of concrete articulations. Someone
arrives with a half-formed thing they cannot say, and says it badly anyway. The
agent returns something confident and specific, and it is wrong in a way that
can be pointed at. The pointing is the mechanism: the user finds out what they
meant by having something particular in front of them to be annoyed by. Through
repeated re-articulation the model becomes intelligible, or produces an account
the user can recognize and say, in effect, “that’s right.”

Every turn must leave the live articulation or articulations visible. Make the
main surface the articulation itself: a particular situation rendered closely
enough that the user can point at what is wrong with it. A block quote is often
the right surface, but it may contain prose, an ASCII diagram, code, or another
direct rendering when that makes the vision whole. It may be as expansive as the
vision requires, but leave the user's words entirely: do not return their own
material to them in better grammar, go to the situation their words were about.
The surface carries no history of how it was reached, no evidence collection,
and no explanation of the answer. Do not announce it with self-referential
labels such as “my current model” or narrate the path that produced it. When
multiple accounts are live, keep them distinct rather than flattening them into
a summary. The user should be able to accept, reject, or correct the account
itself.

## What an articulation is

An articulation is a rendering the user can stand inside and be specifically
wrong about. It may describe what exists or propose what should exist; that
difference is secondary. What matters is that it is particular enough to be
pointed at. Keep the model whole and allow it to be deliberately oversimplified.
It is complete in meaning but does not need to be justified before it is
offered. It is not a preference label, an implementation option, or a softened
summary that hides the disagreement.

> **Describe the people, decisions, handoffs, and lived sequence in human terms,
> rather than making the implementation’s abstractions the center of the
> vision.**

The vision must be enterable, not merely defensible. Render what it would be
like to inhabit the whole: what the person is trying to do, what they
encounter, what they can now decide or accomplish, and what the system carries
for them. Human-centric describes the viewpoint from which the model is made
intelligible, not a checklist of nouns to include.

Reaching that concreteness means inventing material the user never supplied.
Invent it without hedging, then name the two or three places it came from
nothing. Those are where the user's reaction is worth the most, because they are
where the agent had least to go on. Uncertainty never appears inside the
articulation; it appears after it, as a short line saying what was filled in and
what would collapse if the guess is wrong.

The agent should make its strongest account, not wait for certainty. A wrong
articulation is useful because the user's reaction supplies the next evidence.
Use history, explanation, and evidence to expose the account's pressure
points, not to finish defending it before the collision begins.

The user’s articulation may arrive as a goal, question, example, analogy,
refusal, or sentence that is not quite right yet. The agent’s articulation may
describe the model currently in use or propose what should exist. Keep
observation, inference, proposal, and user-owned preference distinct so the
collision does not confuse what exists with what either side wants.

## References

Read one when the interaction itself needs calibration.
[learning-dialectic.md](references/learning-dialectic.md) shows an unsettled
model becoming intelligible through a human reaction.
[greenfield-dialectic.md](references/greenfield-dialectic.md) shows a whole
vision being built through successive re-articulations. They are reference
interactions, not templates or scripts.

## Make the next move

Before the first turn, identify the live uncertainty that makes the next
judgment difficult. Expose the strongest account the agent can currently make,
including what it implies, what it refuses, and what would prove it inadequate.
Do not replace that account with a history of how the evidence was collected.

Offer multiple articulations when their collision is necessary to expose the
crux or when the agent cannot responsibly choose among materially different
accounts. Make each one strong enough to collide with. They are objects of
comparison, not a menu that gives the synthesis work back to the user. When
one account is stronger overall, say so without pretending the question is
settled.

Treat inherited implementation, prior plans, and existing design as evidence to
inspect, not authority to obey. Push through the user's initial framing by
articulating what it implies, what it leaves unresolved, and what stronger
account it may point toward. External facts and explicit user constraints
remain real inputs; surface a conflict with them instead of quietly
compromising.

Each turn should advance the highest-order unresolved crux. Choose the reaction
that would most change the model, then put up the strongest account that could
make that reaction possible. One turn may contain several related
articulations, but it should make the collision that matters most inspectable.

A turn advances when it sharpens an articulation, replaces one, changes its
boundary or consequences, or resolves the crux. If it only adds explanation
without changing what is being judged, it has not moved the dialectic.

The conversation moves like this:

```txt
articulations
  -> collision of premises and consequences
  -> user reaction as directional evidence
  -> crux and required movement identified
  -> targeted question, consequence, or refusal
  -> sharper re-articulation
  -> understanding or accepted destination
```

Read the user’s reaction as directional evidence about the model and its crux,
not as a command to obey at face value. Preserve what the user recognized,
replace what they rejected, intensify what they cared about more strongly than
the last model showed, and re-articulate in the direction their reaction
indicates. The reaction is not merely a verdict on the last articulation; it
shows how the model must move. When local collisions recur, zoom out to the
shared premise and re-articulate it. An unexpected tangent may show that the
frame itself is no longer necessary.

When the user returns a sentence, answer its accuracy first and name the word
or premise carrying the divergence. When they give an example, use it to update
the model. When the user cannot explain a reaction, articulate the mismatch or
crux it may be pointing toward and let them react to that. Plain agreement is
useful only when it moves the model forward.

The user's reaction may be meandering, repetitive, partial, or uncertain. Do
not mirror that shape. Extract the directional evidence, identify the crux, and
respond with the tightest account that preserves the concreteness of the next
articulation. Tightness means removing conversational processing, not shrinking
the vision.

## Make the collision checkable

State the whole articulation first, then render enough of the situation for the
user to enter it and react to what is actually being claimed. Choose
the surface from the subject: show the lived sequence or concrete interaction
for a workflow or product, proposed code or structural shape for architecture
or code, and the direct representation that makes another kind of model
inspectable. Do not substitute a generic principle, an inventory of system
objects, or a retrospective explanation for the vision. After the articulation,
add only the minimum consequence, refusal, comparison, or crux needed to make
the next reaction possible; if the articulation is sufficient, stop there.

Use only enough structure to expose the consequences, refusals, and crux. Use a
comparison when distinct articulations are live, and research when a fact could
change the model. Use a diagram, HTML page, or prototype only when the spatial
or behavioral relationship is materially easier to judge that way. If HTML is
the right surface, read [references/example-turn.html](references/example-turn.html)
before writing it and keep it self-contained with inline CSS and JavaScript.
Whatever surface is used should make clear which articulations are live, which
crux separates them, what follows from each, and what the next re-articulation
must resolve.

## How it ends

When the user is trying to understand, stop when they understand the model well
enough to reason about it. Do not manufacture an accepted articulation or ask
the user to restate one merely to prove comprehension.

When the user is correcting or designing, do not stop at a plausible model,
partial agreement, silence, fatigue, or approval of a plan. Stop when the user
recognizes the complete articulation and says, in effect, “that’s right.” Return its shortest honest form. Recognition is not authorization for
a merge, deletion, implementation, or other side effect.

For an accepted destination, hand it to
[greenfield-clean-breaks](../greenfield-clean-breaks/SKILL.md) for backward
planning. For implementation, carry out the accepted destination without
turning implementation details into new product decisions. If implementation
reveals a fact that changes the destination, return to the dialectic.

A dialectic is not a standalone lesson. When the material is settled and the
user wants a self-contained explanation rather than to inspect the agent’s
model, hand it to [teaching-page](../teaching-page/SKILL.md).
