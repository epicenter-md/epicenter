---
name: dialectic
description: Develop an unsettled idea through one concrete model at a time, rendered as a page the user reacts to and corrects. Use when shaping a vision or architecture before the destination is settled.
---

# Dialectic

A dialectic ends at "that's right." It advances by putting the current model
into a page the other person can open and challenge. Their reaction shows what
is right, wrong, missing, or newly possible, and the next page incorporates it.

The agent is not interviewing the user and the user is not approving a series
of proposals. The agent keeps making the model visible.

## Show the model

Lead with what you think is true. Not a summary of the conversation, not your
reasoning, not a request for approval.

Every turn is a page. One self-contained HTML file: inline style and script,
no CDN, no build step, opens from the filesystem. Write them where git ignores
them and number them within the conversation, so an earlier turn can be named
and reopened. They are scratch and they die with the workspace. Never commit
one.

The message carrying the page is three things: the claim in one sentence, the
path to the file, and the question. The page holds the argument, so writing the
argument again in the message is writing the turn twice.

Quoted code does not go away, it moves inside. A path and a line number are
still what make a claim checkable, so quote the file in the page rather than
paraphrasing it. If the thing does not exist yet, write `// proposed` above it
so a design is never mistaken for source.

Pick the form of each region from its subject, and never dress a comparison, a
history, or a set of tradeoffs as TypeScript. A type that is not a program is a
costume, and it hides the claim inside grey comment text.

## Build the page as an argument

A page shows the part of the model whose consequence is live now. You may be
holding a much larger model than you can show, and a page that renders all of
it looks settled even when it is not. Three regions is usually enough. If you
are building a fourth, you are writing a report.

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

A worked example is in [references/example-turn.html](references/example-turn.html).

## End on the open question

Close with the one question whose answer would change what you show next, in
plain prose, at the end of the page and again in the message. Ask about the
model, not about the turn. "Is preferring the cookie the guarantee, or is a
request carrying both a request to refuse?" is a question about the model.
"Does that sound right?", "which do you choose?", and "should I proceed?" ask
for a verdict, and they get a yes that locates nothing. Do not offer a menu of
labels before the user knows what the labels mean.

Preserve untouched regions when you redraw the page, and drop settled ones out
of the open set instead of asking about them again.

## Read the reply

The claim was wrong: change the model. The framing was wrong: redraw it rather
than defend it. It was too abstract: keep the claim, give the concrete case.
They asked for source: go get the file, because they are not confused, you
asked to be believed instead of checked.

When they point at a region, redraw that region and leave the rest. When they
hand back a sentence, say how close it is and name the one word carrying the
error. When they ask for an example, give an example.

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
