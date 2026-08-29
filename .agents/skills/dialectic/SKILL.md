---
name: dialectic
description: "Develop an unsettled product, architecture, or design question until the user and agent can state one accepted greenfield articulation: a shared, uncompromised statement of what the thing should be. Use when the destination is not settled and the user wants discovery, synthesis, or pushback before a plan exists. Do not use for interrogating an existing plan, a bounded comparison, or choosing files, commits, or execution steps."
---

# Dialectic

A dialectic produces an accepted greenfield articulation. It ends when the user
can recognize that articulation and say, in effect, “that’s right.” The
articulation is one statement of what the thing should be that the user and
agent both actually hold, and that neither softened merely to get the other to
agree. Models, questions, research, examples, diagrams, and revisions are tools
for reaching it, not alternate outputs.

Greenfield means describe the desired product, architecture, or design from
first principles rather than allowing the inherited implementation to define
what is possible. It does not mean ignoring facts or explicit user constraints;
those should be made visible and allowed to change the articulation openly,
never smuggled in as an unspoken compromise. Uncompromising means preserve the
idea's true shape while it is being settled, even when a softer version would be
easier to accept.

At every turn, ask what the current model reveals about the articulation and
what is still missing, false, or softened. Put forward the clearest model you
can defend. The user reacts to it. Treat the reaction as evidence, revise the
model, and repeat until the user recognizes the complete articulation. Do not
stop at a plausible model, partial agreement, silence, or a convenient pause.

## Find the live uncertainty

Before the first turn, identify the uncertainty that makes the next decision
hard. If it is factual, inspect the source or research it before asking the
user to decide. If it is a value, product, or life choice, expose the choice and
give your recommendation. Distinguish observation, inference, proposal, and
user-owned preference when mixing them would mislead.

Carry the larger context yourself. Start with the current model and the
consequence that makes it worth discussing. Do not turn the opening into a
conversation summary, a questionnaire, or a progress report. Do not average
competing interpretations into a compromise just to make the conversation look
settled; choose and defend the strongest greenfield interpretation, then let the
user correct it.

## Make one model checkable

Lead with a claim, not a request for approval. Use the smallest form that lets
the user disagree precisely: a quoted source, concrete example, diagram,
contrast, timeline, or short explanation. One turn should ask for one main
judgment; include supporting context when removing it would make that judgment
impossible.

Match the form to the subject. Quote code when the claim is about code, with a
real path and line number. Mark proposed code as proposed, in the comment
syntax of its own language, so a design cannot be mistaken for source. Use a
comparison for a comparison and a timeline for a history. Do not disguise
either as TypeScript or as a polished status report.

A turn is not a lesson. When the material is settled and the user wants to
understand it rather than judge it, this is the wrong skill: hand it to
[teaching-page](../teaching-page/SKILL.md) and say so.

Use an HTML page when spatial relationships, visual hierarchy, or several
states are materially easier to judge on a page. Keep it self-contained, with
inline CSS and JavaScript, no CDN, and no build step. Write it to an ignored
scratch path and open it in the available browser or file viewer after writing
or redrawing it.

Every heading, label, and value on the page must name something that exists
outside this conversation: a file, a field, a measured number, a term the
user already uses. Coin a term only when adopting it is part of the proposal,
and present the term as a claim the user can reject. A word you invented to
organize your own argument goes in the chat message, not on the page. When
the model's parts have a real appearance, draw each part in its own colours
and type rather than as a generic chart, and when the judgment is about how
something renders, embed the artifact itself.

Before writing a page, read
[references/example-turn.html](references/example-turn.html) and take its two
load-bearing properties, not its sections: the model is drawn in the system's
own materials, and exactly one region is visually unlike the rest, the one
where the user's judgment is required. The example is a form to borrow, not a
template to reproduce.

Every surface must make the live seam visible. Show what you believe, what is
settled, and the unresolved consequence or fork. Label regions when a user
needs to point at one. Do not add a dashboard, badges, decorative controls,
generic headings, or a second rendering of the same thought unless each one
helps the user judge the seam. A page that looks finished but gives the user
nothing specific to correct is a failed turn.

## End on the next judgment

End with one question only when its answer would change the next model. Ask
about the articulation, not about the quality of the turn. “Does that sound right?”
and “should I proceed?” ask for approval and locate nothing. “Which do you
choose?” is appropriate only when the choice belongs to the user and evidence
cannot settle it; state what you recommend and the assumption behind it so the
user can reject the premise, not just the option.

Do not append a question as a ritual. If the next move is research or an agent
decision, make it. If the user owns the unresolved choice, ask the choice
plainly. The message outside an artifact should contain the claim, the artifact
path when one exists, and the question when one exists. Do not repeat the
artifact as a second essay.

## Read the response as evidence

If the claim is wrong, change the model. If the framing is wrong, change the
form. If the idea is too abstract, give the concrete case. If the user asks for
the source, retrieve it. If they point at a region, revise that region and
preserve the parts they did not challenge. An unexpected tangent may reveal a
larger frame that makes the current one unnecessary.

When the user returns a sentence, answer its accuracy first and name the word
or premise carrying the error. When they provide an example, use it to update
the model. Do not defend a weak rendering because it was already written.

Do not smooth the history of the idea. If earlier models were wrong, reversed,
or abandoned, preserve that fact when it changes the current judgment. If the
history does not change the current model, leave it out. A dialectic is not a
transcript, changelog, or story about inevitable progress.

Preserve what the user has recognized and remove settled questions from the
open set. Do not infer recognition from silence, fatigue, partial agreement, or
the absence of another objection. Agreement with a claim is evidence about the
model, not authorization for a merge, deletion, implementation, or other
side-effecting work. A choice about something the user owns authorizes that
choice only.

## Close or hand off

When the user recognizes the complete articulation, return its shortest honest
form and stop for a thinking-only request. That recognition is not approval of a
plan or authorization for side effects; it is recognition that the statement
describes the thing both of you mean. For an accepted articulation, hand it to
[greenfield-clean-breaks](../greenfield-clean-breaks/SKILL.md) for backward
planning. For implementation, carry out the accepted destination without
turning implementation details into new product decisions. If implementation
reveals a fact that changes the articulation, return to this loop.
