---
name: dialectic
description: Develop an unsettled idea through one concrete model at a time and user correction. Use when shaping a vision or architecture before the destination is settled.
---

# Dialectic

A dialectic ends at "that's right." It advances by putting the current model
into a direct form the other person can see and challenge: quoted code, a type,
a sentence, a concrete example, a contrast that carries the live distinction, or
a page they can open.

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

Build a page when the shape is the claim. A before and after, three options
compared, a sequence whose order matters, a state machine: these are spatial,
and prose makes the user assemble the picture before they can disagree with it.
Anything that fits in a sentence stays a sentence.

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

## Build the page as an argument

A page turn is one self-contained HTML file: inline style and script, no CDN,
no build step, opens from the filesystem. Write one per turn and number them,
so the sequence becomes the record of where the model moved and what moved it.
A page costs more than a paragraph, and that cost is the point when the shape
is what the user needs to see.

The styling is the argument rather than decoration. Sequence decides what is
understood first. Contrast puts the live distinction in a single view.
Emphasis marks the one thing carrying the weight. A hero section, a gradient,
and a row of icons assert nothing and spend the top of the page.

Label the regions. The natural correction is to point, and "the second panel is
wrong" needs a second panel with a name. Give every region a short heading and
keep the names stable across redraws, so a correction lands on the thing it
named.

Render the seam. A page that only asserts reads as finished, and a finished
page gives the user's model nothing to catch on. Show what you believe and show
the fork the evidence does not settle, and make the difference visible at a
glance instead of confessing it at the bottom. This is what makes a page a turn
in a dialectic rather than a lecture.

Show the open set, not everything you know. A page that renders the whole model
looks settled even when it is not.

The page does not replace the message. State the claim and the open question in
the reply as well, because the reply is what the user answers.

A worked example is in [references/example-turn.html](references/example-turn.html).

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

A page turn is the exception, because structure is what a page is for. The
message carrying it still stays short.

You may be holding a much larger model than you can show. Show the part whose
consequence is live now.

## Read the reply

The claim was wrong: change the model. The framing was wrong: redraw it rather
than defend it. It was too abstract: keep the claim, give the concrete case.
They asked for source: go get the file, because they are not confused, you
asked to be believed instead of checked.

When they hand back a sentence, say how close it is and name the one word
carrying the error. When they ask for an example, give an example. When they
point at a region of a page, redraw that region and leave the rest.

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
