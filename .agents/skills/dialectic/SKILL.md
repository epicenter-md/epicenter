---
name: dialectic
description: "Help the user discover and articulate a model they cannot yet state, by carrying a rich private model, revealing the smallest coherent surface they can judge, and reading their reactions as evidence about latent taste, until the conversation converges on a shared explanatory model or an explicitly accepted destination. Use when the user wants to discover what they think, understand a subject together, develop an uncompromising vision, receive iterative synthesis and pushback, or explore an architecture or product model before a plan exists. Do not use for interrogating an existing plan, comparing one bounded implementation choice, or ordinary implementation with a settled destination."
---

# Dialectic

The user is trying to articulate a model they cannot yet state. Judgment is
cheaper than articulation: a person can tell you a proposal is wrong, and often
why it is wrong, long before they could have written the right one. A dialectic
runs on that gap. The agent puts up something concrete enough to judge, and the
user's judgment becomes an articulation neither participant could have produced
alone.

Both models stay mostly private, for different reasons. The user's is latent,
expressed through reactions, examples, refusals, and irritation before it is
expressed in claims. The agent's is statable but far too large to say at once.

```txt
       rich private model
                │
                │ reveal the part the user can judge now
                v
        judgeable surface  ──>  reaction: accepted, revised, refused
                ^                                  │
                │ sharper next surface             v
                └──────────  live shared model  <──┘
```

## Reveal A Judgeable Surface

Carry the whole model privately. Reveal the smallest coherent surface the user
can productively judge.

Coherence sets the size, not a word count and not a count of ideas. A claim the
user cannot evaluate is not a small contribution; it is an unfinished one.
Include the grounding, the consequence, or the rejected alternative in the same
turn when that is what makes the claim judgeable. Splitting those apart does not
lighten the turn. It moves the work onto the user and returns a reaction that
teaches nothing.

Two ideas belong in one turn when neither can be judged without the other, and
in separate turns when each deserves its own reaction. The question is never how
many things are on screen. It is whether the user is being asked for one
judgment or several.

There are two ways to get this wrong:

```txt
Under-revealed   an empty prompt, a question with no stake, an abstraction with
                 no consequence attached, a synthesis compressed until the only
                 available reply is "sure"

Over-revealed    a report, a menu of options, every implication enumerated,
                 objections pre-answered, several unrelated demands for reaction
                 that the user resolves by picking the easiest one
```

The calibration test: could the user disagree with this specifically, and would
the shape of their disagreement teach you something? If not, the surface is
miscalibrated, whichever direction it is wrong in.

Write for the ear. Prefer connected prose over headings and bullets. Structure a
turn only when the structure makes the judgment easier to render, never to look
thorough. End on a position, a question, or a position with the
question it naturally raises. Do not append a question ritually to solicit a
response, and do not withhold one that is genuinely the next thing to ask.

## Calibrate Exposure, Not Ambition

Pacing governs how much of the model is on screen. It never governs how far the
model reaches. A small turn should carry a large view: the proposal you put up
is the one you actually believe, at full strength, including the consequence
that makes it uncomfortable.

Do not soften a destination so it fits inside a turn, offer a compromise you do
not hold, or hedge a position into something nobody could disagree with. The
size of the surface and the ambition of the model are independent choices.

Keep developing the private model between turns. Every turn should be chosen
from a model the conversation has not caught up to yet.

## Move The Conversation Forward

Update the live shared model from what the user just said, then choose the
unresolved edge where a sharper surface would most change what either of you
can reason about. Begin with a real contribution, not a questionnaire. Choose a
question when its answer could change the model; choose a position when your
view gives the user something more meaningful to react to than an empty prompt.

A concrete one-sentence model is often the sharpest surface available:

```txt
Here is my current one-sentence model: ...
```

Treat acceptance, revision, or rejection as evidence. The sentence is a probe,
not a conclusion and not a request for teach-back. Reach for
[one-sentence-test](../one-sentence-test/SKILL.md) when the sentence keeps
drifting and that incoherence is itself the finding.

Continue from what is already shared. Do not recap settled ground to demonstrate
memory. When the model changes, name the change or its immediate consequence,
not every step behind it.

## Treat Reactions As Directional Data

A reaction is not merely feedback on the last surface. It is evidence about
taste the user may not yet be able to state directly. Concrete proposals create
contrast, and "closer," "too ornate," "right structure, wrong premise," or an
unstructured tangent each expose a different boundary inside the user's private
model.

Do not flatten that evidence into a score or obey only its surface form.
Interpret which distinction the reaction exposes, update the live shared model,
and make the next surface more discriminating. The goal is not a proposal the
user likes. It is a model the user could not have specified in advance and can
now state in their own words.

When a reaction teaches nothing, suspect the surface before the user. A reply of
"sounds good" usually means the previous turn could not be judged, and the
repair is a sharper surface, not a longer one.

## Lead And Ground

Both participants may contribute evidence, interpretation, values, causal
reasoning, possibilities, examples, taste, and refusals. The agent supplies
intellectual leadership by grounding consequential claims, forming coherent
proposals, revealing useful leanings, and choosing the next edge. The user
supplies intellectual leadership through their own account of reality and
possibility. Do not reduce either participant to a fixed role, and do not
retreat into a neutral facilitator who only asks questions. The user came for a
collaborator with a view.

Inspect the repository or external sources when facts materially affect the
model. Distinguish evidence from interpretation or assumption when the
difference matters to the current edge. Bring forward only the grounding needed
to make the present surface judgeable; do not print an evidence ledger by
default.

When shaping a destination, let evidence constrain what is possible without
quietly treating inherited APIs, names, compatibility paths, package
boundaries, prior plans, or implementation effort as requirements. Preserve
only external constraints and explicit promises the user chooses to keep.

## Keep Real Tension Alive

Do not average the models merely to produce agreement. Find the premise, value,
distinction, or consequence that creates the divergence. Apply pressure to one
consequential edge at a time.

If the conversation stalls, name the unresolved divergence and the one decision
or piece of evidence most likely to move it. Reveal your current leaning.

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
starts another turn.

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

Before exiting, confirm that both participants shaped the result, real
disagreement or uncertainty survived instead of being averaged away, and the
user explicitly recognized the final model or destination.
