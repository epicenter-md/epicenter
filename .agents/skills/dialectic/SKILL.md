---
name: dialectic
description: "Make an unsettled product, architecture, or design model visible through the deliberate collision of articulations. Use when the user wants to understand the agent's current model, correct it, or discover an accepted greenfield destination before a plan exists. Do not use for a settled subject that needs a standalone lesson, interrogating an existing plan, a bounded comparison, or choosing files, commits, or execution steps."
---

# Dialectic

A dialectic is the deliberate collision of articulations: the user’s emerging
account of what should be true and the agent’s competing greenfield accounts.
Their differences, consequences, and refusals make the real choice visible. A
dialectic produces an accepted greenfield articulation. It ends when the user
can recognize that articulation and say, in effect, “that’s right.”

The collision can serve understanding or correction. In a learning dialectic,
the user wants the agent’s current model made intelligible and does not need to
endorse or restate it. In a corrective or design dialectic, the user and agent
compare serious articulations until an accepted greenfield account emerges.

## What an articulation is

An articulation is a positive account of what should be true: its objects,
verbs, boundaries, owners, consequences, and refusals. It is not a preference
label, an implementation option, or a softened summary that hides the point of
disagreement.

The user’s articulation may arrive as a goal, question, example, analogy,
refusal, or sentence that is not quite right yet. The agent’s articulation may
describe the model it is currently using or propose what should exist. Keep
observation, inference, proposal, and user-owned preference distinct so the
collision does not confuse what exists with what either side wants.

## Establish the collision

Before the first turn, identify the live uncertainty that makes the next
judgment difficult. In a learning dialectic, expose the agent’s current model:
its premises, structure, evidence, assumptions, and consequences. In a
corrective or design dialectic, expose the user’s emerging ideal alongside the
agent’s strongest greenfield account.

Lead with a claim, not a questionnaire. When a real fork remains, put forward
several serious articulations whose premises genuinely differ. Make each one
strong enough to defend, including what it refuses and what follows from it.
They are objects of comparison, not a menu that gives the synthesis work back
to the user. Recommend a direction when the evidence and model support one.

Treat inherited implementation, prior plans, and existing design as evidence to
inspect, not authority to obey. Push against them when they narrow the desired
system by habit. Push against the user’s framing when it conflicts with the
outcome they appear to want or with a premise they have already accepted. Make
the disagreement concrete so the user can correct the premise rather than
merely defer to the agent. External facts and explicit user constraints remain
real inputs; surface a conflict with them instead of quietly compromising.

## Move the model forward

One turn should make one consequential collision inspectable, even when it puts
several articulations beside each other. Give enough structure for a precise
reaction, then leave the unresolved seam visible. The conversation moves like
this:

```txt
articulations
  -> collision of premises and consequences
  -> user reaction as directional evidence
  -> sharper articulation
  -> understanding or accepted destination
```

Read the reaction as evidence about the model, not as a command to obey at
face value. Preserve what the user recognized, replace what they rejected,
intensify what they cared about more strongly than the last model showed, and
resolve the tension their reaction exposed. Do not merely paraphrase the latest
message or defend a weak rendering because it already exists.

When the user returns a sentence, answer its accuracy first and name the word or
premise carrying the divergence. When they give an example, use it to update
the model. A wrong articulation is useful because it locates the disagreement;
plain agreement is useful only when it moves the model forward.

## Make the collision checkable

Use the smallest form that lets the user judge the live seam. Use a concrete
example when the idea is abstract, a comparison when articulations are peers on
one axis, a timeline for history, quoted code when the claim is about code, and
research when a fact could change the model. Use a diagram, HTML page, or
prototype only when the spatial or behavioral relationship is materially easier
to judge that way. The surface should show what is believed, what is settled,
and what remains under pressure; it should not make a finished-looking artifact
that gives the user nothing specific to correct.

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
agreement, silence, exhaustion, or approval of a plan. Stop when the user
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
