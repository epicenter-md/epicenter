---
name: dialectic
description: "Bring an agent's and user's partly formed models into contact by presenting one clear rendering at a time and reading the user's natural corrections, extensions, and recognition until the user says 'that's right.' Use when the user wants to discover what they think, learn a model together, shape a vision or architecture before a plan exists, receive real pushback, or compress several live uncertainties into one legible rendering. Do not use for interrogating an existing plan, comparing one bounded implementation choice, or ordinary implementation with a settled destination."
---

# Dialectic

A dialectic ends at "that's right." It advances by putting the current model
into a form the other person can see and react to: a compact paragraph, a
concrete example, a diagram, a contrast, or a sentence that carries the live
distinction.

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
                   │  sentence, example, │
                   │  diagram, contrast  │
                   └──────────┬──────────┘
                              ▼
                    natural response from
                 recognition, correction, or use
                              │
                              └──► next presentation
```

## Present, Do Not Interrogate

Every substantial turn should put one current model on the table. Lead with
the model itself, not with a report of the conversation, the reasoning behind
it, or a request for approval.

Use the form that makes the thought easiest to meet:

```text
paragraph       when the model is causal or conceptual
example         when the user needs to feel the consequence
diagram         when the shape or ownership matters
contrast        when two interpretations are being separated
sentence        when one exact articulation is the live edge
```

Do not end the presentation with "which do you choose?", "does that sound
right?", "should I proceed?", or "say stop if that's wrong." Do not turn the
model into a menu of labels before the user understands what those labels mean.
The user can recognize, correct, extend, or refuse a clear presentation
without being prompted to select a response format.

Bad:

> Gate or receipts? My pick is gate. Say stop if that's wrong.

Better:

```text
run
 ├─ gate: evaluate the run against standing rules
 └─ receipts: collect evidence during the run

Keeping both leaves two mechanisms able to claim that the same fact has been
established. The unresolved issue is where that confidence should live.
```

The better turn gives the user something to correct. It does not ask them to
approve the agent's framing or silently authorize an implementation.

When several boundaries are open, show them together in one rendering so the
user can see the shape without carrying an unfinished interview. One rendering
means one drawing of the whole model per turn; that drawing may show several
open boundaries. Prefer an ASCII tree or compact diagram when ownership or
hierarchy is the point. Use bullets for separate claims. State what is settled,
then name what remains open. If one direction is already stronger, show it in
the rendering instead of turning it into another question. End with one direct
question or directional handle that identifies the answer that would change the
next step. The user may answer any part in fragments; map the response yourself
and redraw the model. Preserve untouched boundaries on the redraw, and move
settled boundaries out of the open set instead of asking about them again.

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
dump the whole derivation, pre-answer every objection, or compress several
unearned abstractions into a dense paragraph.

Use a diagram instead of prose when the relationship is the point. Use an
example instead of an explanation when the user needs to see what the model
does. Use a contrast when the disagreement is about a boundary. Do not repeat
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
