---
name: dialectic
description: Develop an unsettled idea through one concrete model at a time and user correction. Use when shaping a vision or architecture before the destination is settled.
---

# Dialectic

A dialectic ends at "that's right." It advances by putting the current model
into a direct form the other person can see and challenge: quoted code, a type,
a sentence, a concrete example, or a contrast that carries the live distinction.

The agent is not interviewing the user and the user is not approving a series
of proposals. The agent keeps making the model visible. The user's natural
response shows what is right, wrong, missing, or newly possible. The next
rendering incorporates that response.

## Show the model

Lead with what you think is true. Not a summary of the conversation, not your
reasoning, not a request for approval.

Make the claim checkable with the smallest concrete thing that carries it: a
quoted file with its path and line, a real example, a count, a contrast. Quote
the file instead of paraphrasing, because a path and a line number are
something the user can go read. If the thing does not exist yet, write
`// proposed` above it so a design is never mistaken for source.

Pick the form from the subject. Code claim, quote the code. Everything else,
write sentences. Never dress a comparison, a history, or a set of tradeoffs as
TypeScript. A type that is not a program is a costume, and it hides the claim
inside grey comment text.

A turn about code looks like this:

> Cookie-first is not a preference in this file, it is unconditional:
>
> ```ts
> // packages/server/src/middleware/require-auth.ts:138
> const session = await c.var.auth.api.getSession({
> 	headers: c.req.raw.headers,
> });
> if (session) { c.set('principal', ...); return next(); }
> const bearer = parseBearer(c.req.header('authorization') ?? null);
> ```
>
> A request carrying both credentials never reaches the bearer line, so two
> credentials naming two different principals resolve silently to one. Is
> preferring the cookie the guarantee, or is a request carrying both a
> request to refuse?

The question is prose under the code, in full sentences, as the last line.
Never bury it in a comment inside the fence.

## End on the open question

Close with the one question whose answer would change what you show next, in
plain prose, as the last line. Ask about the model, not about the turn.
"Is preferring the cookie the guarantee, or is a request carrying both a
request to refuse?" is a question about the model. "Does that sound right?",
"which do you choose?", and "should I proceed?" ask for a verdict, and they get
a yes that locates nothing. Do not offer a menu of labels before the user knows
what the labels mean.

Preserve untouched parts of the model when you redraw it, and drop settled ones
out of the open set instead of asking about them again.

## Keep it short and connected

A turn is a few paragraphs that follow from each other. If you are writing a
third heading, you are writing a report. If a paragraph ends on a punchy
fragment, cut the fragment and write the connection it replaced.

You may be holding a much larger model than you can show. Show the part whose
consequence is live now.

## Read the reply

The claim was wrong: change the model. The framing was wrong: redraw it rather
than defend it. It was too abstract: keep the claim, give the concrete case.
They asked for source: go get the file, because they are not confused, you
asked to be believed instead of checked.

When they hand back a sentence, say how close it is and name the one word
carrying the error. When they ask for an example, give an example.

Agreement is evidence, not authorization. It does not license a merge, a
deletion, or an implementation.

## After "that's right"

Return the model and stop, hand a greenfield destination to
[greenfield-clean-breaks](../greenfield-clean-breaks/SKILL.md), or implement it
without turning implementation choices into new product decisions. If
implementation turns up a fact that changes ownership or what the system
allows, say so and come back here.

Do not use this to collect approval for a settled plan. If the question is
which commits or files should land, use the review or execution skill directly.
