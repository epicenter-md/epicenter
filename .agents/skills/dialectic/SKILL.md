---
name: dialectic
description: "Make an unsettled product, architecture, or design model visible through the deliberate collision of articulations. Use when the user asks for a dialectic, asks to hear or see the full articulation of a model, or wants to understand, correct, or redesign an unsettled model."
---

# Dialectic

A dialectic is the deliberate collision of articulations: the user’s emerging
account of what should be true and the agent’s competing greenfield accounts.
Their differences, consequences, and refusals expose the cruxes that the next
articulation must resolve. Through repeated re-articulation and crux-finding,
the collision either makes the agent’s model intelligible or produces an
accepted greenfield articulation. In the latter case, it ends when the user can
recognize that articulation and say, in effect, “that’s right.”

Every dialectic turn must leave one clear current articulation visible. Put it
in a prominent block quote, in plain words, even if deliberately simplified or
oversimplified, while keeping the disagreement visible so the user can accept,
reject, or correct the model itself without extracting it from the surrounding
analysis.

## What an articulation is

An articulation is a complete account of a model: its objects, verbs,
boundaries, owners, consequences, and refusals. It may explain a model
currently in use or propose a greenfield model. The dialectic’s destination
determines whether that account is being made intelligible or accepted as what
should exist. It is not a preference label, an implementation option, or a
softened summary that hides the point of disagreement.

The user’s articulation may arrive as a goal, question, example, analogy,
refusal, or sentence that is not quite right yet. The agent’s articulation may
describe the model it is currently using or propose what should exist. Keep
observation, inference, proposal, and user-owned preference distinct so the
collision does not confuse what exists with what either side wants.

## Destinations

The collision can serve understanding or correction. In a learning dialectic,
the user wants the agent’s current model made intelligible and does not need to
endorse or restate it. In a corrective or design dialectic, the user and agent
compare serious articulations until an accepted greenfield account emerges.

## Establish the collision

Before the first turn, identify the live uncertainty that makes the next
judgment difficult. In a learning dialectic, expose the agent’s current model:
its premises, structure, evidence, assumptions, and consequences. In a
corrective or design dialectic, expose the user’s emerging ideal alongside the
agent’s strongest greenfield account.

Begin with one strong account the agent can defend. Offer multiple serious
articulations only when the agent cannot responsibly choose among materially
different accounts, or when their contrast is necessary to expose a crux. Make
each one strong enough to defend, including what it refuses and what follows
from it. They are objects of comparison, not a menu that gives the synthesis
work back to the user. When multiple articulations are needed, conclude the
comparison with a recommendation: identify the strongest overall account when
one exists, or give context-specific recommendations with their tradeoffs.

Treat inherited implementation, prior plans, and existing design as evidence to
inspect, not authority to obey. Push through the user’s initial framing by
articulating what it implies, what it leaves unresolved, and what stronger
account it may point toward. Let the user’s reaction show whether that account
captures what they mean or exposes a crux that the next articulation must
resolve. Make the disagreement concrete so the user can correct the premise
rather than merely defer to the agent. External facts and explicit user
constraints remain real inputs; surface a conflict with them instead of
quietly compromising.

## Move the model forward

Each turn should advance the highest-order unresolved crux. Related local
collisions may appear within that movement; when they recur, zoom out to the
shared premise and re-articulate it. Give enough structure for a precise
reaction, then leave the unresolved seam visible. The conversation moves like
this:

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
shows how the model must move. Do not merely paraphrase the latest message or
defend a weak rendering because it already exists.

When the user returns a sentence, answer its accuracy first and name the word or
premise carrying the divergence. When they give an example, use it to update
the model. A wrong articulation is useful because the user’s reaction to it
shows what the next articulation must change. Plain agreement is useful only
when it moves the model forward.

When the user cannot explain a reaction, articulate the mismatch or crux it may
be pointing toward and let the user react to that.

## Make the collision checkable

Use the smallest form that lets the user judge the current articulations and
the live crux. Use a concrete example when the idea is abstract, a comparison
when articulations are peers on one axis, a timeline for history, quoted code
when the claim is about code, and research when a fact could change the model.
Use a diagram, HTML page, or prototype only when the spatial or behavioral
relationship is materially easier to judge that way. The surface should show
which articulations are on the table, which crux separates them, what follows
from each, and what the next re-articulation must resolve; it should not make a
finished-looking artifact that gives the user nothing specific to correct.

When an HTML page is the right surface, keep it self-contained with inline CSS
and JavaScript, no CDN, and no build step. Write it to an ignored scratch path
and open it after writing or redrawing it. Before writing the page, read
[references/example-turn.html](references/example-turn.html) and borrow its
load-bearing properties: draw the model in the system’s own materials and make
the region requiring the user’s judgment visually distinct. The example is a
form to borrow, not a template to reproduce.

## End according to the destination

In a learning dialectic, stop when the user understands the agent’s model well
enough to reason about it. Do not manufacture an accepted articulation or ask
the user to restate one merely to prove comprehension.

In a corrective or design dialectic, do not stop at a plausible model, partial
agreement, silence, fatigue, or approval of a plan. Stop when the user
recognizes the complete greenfield articulation and says, in effect, “that’s
right.” Return its shortest honest form. Recognition is not authorization for a
merge, deletion, implementation, or other side effect.

For an accepted greenfield destination, hand it to
[greenfield-clean-breaks](../greenfield-clean-breaks/SKILL.md) for backward
planning. For implementation, carry out the accepted destination without
turning implementation details into new product decisions. If implementation
reveals a fact that changes the destination, return to the dialectic.

A dialectic is not a standalone lesson. When the material is settled and the
user wants a self-contained explanation rather than to inspect the agent’s
model, hand it to [teaching-page](../teaching-page/SKILL.md).
