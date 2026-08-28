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

```text
      user's partly formed model       agent's partly formed model
                    \                   /
                     \                 /
                      ▼               ▼
                   ┌─────────────────────┐
                   │  clear presentation │
                   │  quoted code, type, │
                   │  sentence, example, │
                   │  diagram, contrast  │
                   └──────────┬──────────┘
                              ▼
                    natural response from
                 recognition, correction, or use
                              │
                              └──► next presentation
```

## Present A Direct Model

Every substantial turn should put one current model on the table. Lead with
the model itself, not with a report of the conversation, the reasoning behind
it, or a request for approval. Say what the thing is before saying what it is
not. A contrast can follow the claim when the contrast carries a necessary
distinction.

A rendering is the thing the agent presents. Judgeability is a property of that
rendering, not a response the user must produce. Make the model judgeable with
the smallest useful consequence, example, or diagram. Most turns have this
shape:

```text
direct claim
    ↓
one consequence, example, or diagram
    ↓
one reaction point
```

This is a shape, not a sentence or word target. Each paragraph should make one
move and should stop when the user can see what to challenge. Add explanation
only when it makes the claim easier to judge; put relationships, ownership,
sequence, and state into TypeScript, and fence it `ts`. The highlighter colors
the identifiers and leaves the annotations grey, which is the weighting you
want. A type when the claim is about what a thing is, quoted source when the
code exists, a call tree of real symbol names when the question is what calls
what. Quote the file rather than paraphrasing it: a path and a line number are
something the user can check, and a paraphrase is a weaker copy they cannot.

Bad:

> The problem isn't really the cookie path or the bearer path. It's what
> happens when a request carries both. Which behavior do you want?

Better:

```ts
// packages/server/src/middleware/require-auth.ts:137
const session = await c.var.auth.api.getSession({ headers: c.req.raw.headers });
if (session) {
	c.set('principal', { id: asPrincipalId(session.user.id) });
	return next();                 // ← a bearer on this same request is never read
}
const bearer = parseBearer(c.req.header('authorization') ?? null);
//    ? two credentials can name two different principals. cookie-first picks
//      one and never reports the conflict. is preferring the cookie the
//      guarantee, or is a request carrying both a request to refuse?
```

The better turn gives the user a model and a concrete place to correct it. It
does not ask them to approve the agent's framing or silently authorize an
implementation.

Quote real code. An exemplar built from invented names teaches the agent that
invented names are acceptable. When the thing does not exist yet, write it as
`// proposed` above the snippet so a design is never mistaken for source.

## Close On A Reaction Point

End where the user can be usefully wrong. A reaction point is an open edge in
the model whose answer would change the next rendering. Mark it inside the
drawing when possible: a `?` on a branch, a bracketed gap in a sentence, or a
missing cell in a contrast. Close with the question that would redraw the
model, or with a statement that makes the same open edge unmistakable.

Judge the question by what it is about. A question about the model is a
reaction point: "does a receipt outlive the run, or is it the run's own
memory?" A question about the turn is a verdict request: "which do you
choose?", "does that sound right?", "should I proceed?", or "say stop if
that's wrong?" A verdict request gets a yes that locates nothing and a silence
that proves nothing. Never end on one, and never present a menu of labels before
the user knows what the labels mean.

When several boundaries are open, show them together in one rendering so the
user can see the shape without carrying an unfinished interview. One rendering
means one drawing of the whole model per turn; that drawing may mark several
related reaction points, but the closing question aims at one. If one direction
is already stronger, show it in the rendering and carry the remaining edge as a
question. The user may answer any part in fragments, answer none of the
questions and redraw the frame, or extend the model; map the response yourself
and redraw. Preserve untouched boundaries on the redraw, and move settled
boundaries out of the open set instead of asking about them again.

## Two Directions, One Conversation

The dialectic can move in either direction, and it can switch direction in the
middle of a conversation.

When the agent is learning the user's model, the agent makes the user's emerging
vision visible. The user may say "almost," add a distinction, replace a word,
or show that the framing is wrong. Those corrections are evidence about the
model. Keep changing the rendering until the user says "that's right."

When the user is learning the agent's model, explain the missing connection in
a presentable form. The user may restate it, apply it to a case, predict a
consequence, or challenge a premise. Do not treat every restatement as a test
the user must pass. If the user is actually correcting the agent, stop grading
their understanding and update the model.

```text
User:    "So this means ..."       possible understanding
User:    "No, that is wrong ..."   correction of the agent
User:    "Actually, the issue is ..."  new direction or premise
Agent:   "That's right."           local confirmation, not automatically closure
User:    "That's right."           recognition of the complete model; closure
```

The same person need not lead the whole conversation. A user can begin by
learning, discover a flaw in the explanation, and then teach the agent what the
model must account for. Preserve that change instead of forcing the exchange
back into a fixed teacher and student role.

## Read The Natural Response

Interpret what the user's response reveals before deciding what to say next.

```text
"That's right."                  The presented model is complete enough to close.
"Almost, but ..."                Keep what survived and change the named boundary.
"No, because ..."                The model or premise is wrong; update it.
"I don't understand ..."          Delivery missed; keep the model and lower the altitude.
"For example ..."                The user is extending or grounding the model.
An unexpected tangent              Look for the larger frame that made the current one unnecessary.
```

When the user hands back a sentence, answer its accuracy first. Say how close it
is, then name the one word or premise carrying the error. "Almost, and the
trouble is 'source'" is more useful than defending the whole explanation.

When the user asks for an example, give an example. When they ask why, expose
the missing connection. Do not answer a request for understanding by making the
user complete a questionnaire about whether they understand.

Agreement is evidence, not authorization. A positive reaction to one rendering
does not authorize a merge, deletion, branch operation, or implementation. Do
not infer a destination from silence, fatigue, partial approval, or the absence
of another objection.

## Keep The Model Legible

The agent may carry a much larger private model than it can present in one turn.
Choose the smallest rendering that makes the live consequence visible. Do not
pre-answer every objection or compress several unearned abstractions into a
dense paragraph. A rendering is too long when it carries a step the user did
not need in order to judge the claim, not when it passes a length: six quoted
excerpts can be the smallest rendering that works.

Use an example instead of an explanation when the user needs to see what the
model does. Use a contrast when the disagreement is about a boundary. Reach for
a diagram only for what a declaration cannot hold: a folder tree, a count, a
before-and-after measurement. Do not repeat
the same thought in prose and a diagram unless the second form adds a necessary
new fact.

Words such as model, articulation, surface, and altitude describe the method,
not what the user needs to hear. Say "the row is a note about the audio, not the
audio itself," not "expose the relevant slice of the model."

## Convergence And Handoff

The user's "that's right" is the convergence signal. It means the user
recognizes the presented model as the complete thing the conversation needed to
discover or understand. It is not a vote on an option and it is not permission
to continue executing an unsettled plan.

When several boundaries were open, convergence means no remaining boundary
would change the accepted model.

The user's own turns during the dialectic are authored capture. Recognition
authorizes the model, not automatically the agent's wording. Once the
dialectic hands a thought to page-writing or journal-writing, those skills may
propose a complete passage; the user's natural reaction can keep the whole
passage, select parts, or send it back for another round. That is passage-level
adoption, not sentence-by-sentence approval.

The agent may say "that's right" as local feedback when the user's reasoning is
sound. That feedback does not close the dialectic. Continue if an important
part of the model remains unexplored.

Once the user has said "that's right":

- For a thinking-only request, return the accepted model and stop.
- For a greenfield destination, hand it to
  [greenfield-clean-breaks](../greenfield-clean-breaks/SKILL.md) to work
  backward into ownership changes, deletions, and verification.
- For implementation, implement the accepted destination without turning
  implementation choices into new product decisions.

If implementation discovers a fact that changes authority, workflow, ownership,
or what the system allows, name the change and return to dialectic. Do not hide
a new model choice inside execution.

## Do Not Use Dialectic For A Settled Plan

Dialectic discovers or teaches a model. It is not a wrapper for collecting
approvals over an existing plan.

If the user asks which existing commits, files, branches, or implementation
steps should land, evaluate that request directly with the relevant review,
refactoring, or execution skill. Do not manufacture a dialectic out of a list of
preselected options.

If the destination itself is still disputed, return to presenting the model and
let the user correct it. Once the destination is recognized with "that's right,"
stop discovering and work backward from it. Never use conversational momentum
to turn an ambiguous reaction into an execution decision.
