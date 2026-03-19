---
name: writing-voice
description: Voice and tone rules for all written content—prose, UI text, tooltips, error messages. Use when writing any user-facing text.
metadata:
  author: epicenter
  version: '1.0'
---

# Writing Voice

**Core principle**: Write for the ear, not just the eyes. Prose should be suitable to read out loud.

## When to Apply This Skill

Use this pattern when you need to:

- Write user-facing text like UI copy, tooltips, error messages, or prose.
- Rewrite text that sounds corporate, stilted, or AI-generated.
- Explain technical concepts with concrete mechanisms instead of abstract claims.
- Match the user's tone and pacing in responses.
- Draft product/open-source writing with honest trade-offs and specifics.

## The Test

Read it out loud. If it:

- Sounds like a press release → rewrite
- Sounds like a corporate memo → rewrite
- Sounds stilted or unnatural → rewrite
- Sounds like you explaining to a colleague → ship it

## AI Dead Giveaways

Patterns that scream "AI wrote this":

- **Bold formatting everywhere**: Never bold section headers in body content
- **Bullet list everything**: Convert to flowing paragraphs when possible
- **Marketing words**: "game-changing", "revolutionary", "unleash", "empower"
- **Structured sections**: "Key Features:", "Benefits:", "Why This Matters:"
- **Vague superlatives**: "incredibly powerful", "seamlessly integrates"
- **Dramatic hyperbole**: "feels like an eternity", "pain point", "excruciating"—use facts instead
- **AI adjectives**: "perfectly", "effortlessly", "beautifully"
- **Space-hyphen-space**: "The code works - the tests pass"
- **Overusing fragments**: "Every. Single. Time." (once is emphasis, twice is a pattern)
- **Staccato buildup**: Setup. Fragment. Fragment. Fragment. Punchline. This "dramatic reveal" pattern feels manufactured. Combine into one flowing sentence with em dashes or semicolons instead.
- **Forced specificity**: Random numbers that don't add meaning

## Punctuation

Em dashes (—) are always closed—no surrounding spaces. Never ` — ` or ` - `.

| Prefer        | When                                                           |
| ------------- | -------------------------------------------------------------- |
| Period (.)    | Default choice. Two sentences are often clearer than one.      |
| Colon (:)     | Introducing explanation: "Here's the thing: it doesn't work"   |
| Semicolon (;) | Related independent clauses: "The code works; the tests pass"  |
| Em dash (—)   | Asides and emphasis, always closed: "It's fast—really fast"    |

When in doubt, use a period.

## How to Write Good Prose

The previous sections say what to avoid. This section says what to do.

### Lead with the point

Every paragraph should open with its conclusion. Setup comes after, not before. The reader should know where you're going before you take them there.

Bad (buries the point):

> After investigating several approaches to conflict resolution, including CRDTs, operational transforms, and manual merge strategies, we found that Yjs with LWW timestamps gave us the best combination of correctness and simplicity.

Good (leads with it):

> Yjs with LWW timestamps gave us the best conflict resolution. We tried CRDTs without timestamps, operational transforms, and manual merge strategies; none matched it for correctness with this little code.

### Vary sentence length

Monotone sentence length is the fastest way to sound robotic. Mix short declarative sentences with longer explanatory ones. Short sentences punch. Longer ones carry nuance and connect ideas that need to live together.

Bad (uniform length):

> The system processes incoming events. It validates each event against the schema. It then routes the event to the appropriate handler. The handler updates the database accordingly.

Good (varied rhythm):

> The system validates incoming events against the schema and routes them to the right handler. Simple enough. But the handler has to update the database, notify subscribers, and maintain the audit log in a single transaction. That's where it gets interesting.

### Use concrete language

Abstract language forces the reader to do translation work. Concrete language lets them see it immediately.

Bad (abstract):

> This approach provides significant performance improvements for data retrieval operations.

Good (concrete):

> Row lookups dropped from O(n) to O(1). On a 10,000-row table, that's the difference between scanning every cell and a single hash lookup.

### Connect ideas without headers

Not every transition needs a section heading. Use bridge sentences: one sentence at the end of a paragraph that sets up the next topic, or one at the start that links back. Headers break the reader's flow; use them for major shifts, not every new thought.

Bad (header-heavy):

> ## The Problem
> Sessions were timing out.
>
> ## The Root Cause
> The refresh only triggered on navigation.
>
> ## The Solution
> We added a keepalive to background activity.

Good (flowing):

> Sessions were timing out during file uploads. The refresh logic only triggered on navigation events, so any background activity—uploads, sync, long-running mutations—would silently lose the session.
>
> The fix was a keepalive that fires on any authenticated request, not just page transitions.

## Common Rewrite Patterns

Mechanical substitutions you can apply without judgment:

| If you wrote...                              | Rewrite to...                              |
| -------------------------------------------- | ------------------------------------------ |
| "It's important to note that X"              | "X"                                        |
| "In order to achieve Y, we need to Z"        | "Z gives us Y"                             |
| "The reason this works is because..."        | "This works because..."                    |
| "What this means is that..."                 | State it directly                          |
| "It should be noted that..."                 | Drop it entirely                           |
| "Basically, X"                               | "X"                                        |
| "As mentioned earlier/above"                 | Just re-state the thing                    |
| "This allows us to..."                       | "We can now..." or "Now X works"           |
| "We need to make sure that..."               | "X must..." or just do it                  |
| "In the context of..."                       | Drop it or be specific                     |
| "It is worth mentioning that..."             | Mention it or don't                        |
| "Going forward, we will..."                  | "Next: ..." or just describe the action    |
| "leverage" / "utilize"                       | "use"                                      |
| "facilitate"                                 | "let", "enable", or "allow"                |
| "implement a solution"                       | "fix it" / "build it" / say what you built |

## Explaining Technical Concepts

When explaining how something works, show the mechanism, not the marketing. Lead with what happens, then why.

Bad (over-explains, AI voice):

> The key insight here is that by leveraging Yjs's built-in conflict resolution mechanism, we can effectively handle concurrent edits in a way that seamlessly maintains consistency across all connected clients.

Good (direct, shows the mechanism):

> Yjs resolves conflicts automatically. Two users edit the same field, both edits survive in the CRDT, and the LWW timestamp picks the winner. No manual merge logic needed.

Bad (abstract):

> The factory function pattern provides a clean separation of concerns by encapsulating the client creation logic and exposing a well-defined interface for consumers.

Good (concrete):

> `createSync()` takes a Y.Doc and returns three methods: `connect()`, `disconnect()`, and `status()`. The consumer never touches WebSocket setup, reconnection logic, or auth token refresh. They call `connect()` and it works.

## Natural Prose

- Write like a human telling a story, not a press kit.
- Avoid emojis in headings and formal content unless explicitly requested

## Open Source & Product Writing

When writing landing pages or product-facing prose:

- Start with what the tool actually does, not why it's amazing
- Emphasize user control and data ownership
- Highlight transparency: audit the code, no tracking, no middleman
- Present honest cost comparisons with specific, real numbers
- Acknowledge limitations and trade-offs openly
- Use honest comparative language: "We believe X should be Y"
- Present facts and let users draw conclusions

## Good vs Bad Example

Good (natural, human):

"I was paying $30/month for a transcription app. Then I did the math: the actual API calls cost about $0.36/hour. At my usage (3-4 hours/day), I was paying $30 for what should cost $3.

So I built Whispering to cut out the middleman. You bring your own API key, your audio goes directly to the provider, and you pay actual costs. No subscription, no data collection, no lock-in."

Bad (AI-generated feel):

"**Introducing Whispering** - A revolutionary transcription solution that empowers users with unprecedented control.

**Key Benefits:**

- **Cost-Effective**: Save up to 90% on transcription costs
- **Privacy-First**: Your data never leaves your control
- **Flexible**: Multiple provider options available

**Why Whispering?** We believe transcription should be accessible to everyone..."

The difference: story vs structured sections, personal vs corporate, specific numbers vs vague claims.

## Voice Matching

When the user provides example text or tone guidance, match it:

- If they're terse, be terse
- If they give 5 sentences, don't write 5 paragraphs
- If they use direct statements, don't add narrative fluff
- Match their energy, not a template

## Financial Language

Epicenter's primary goal is not to make money. Vision and mission come first. Financial sustainability exists to fund more open-source development and sponsor contributors—it's a means, not the point.

When writing about how the project sustains itself, be cautious with language that sounds like a pitch deck. Avoid "revenue," "monetization," "ARR," dollar-figure valuations, and other tech bro jargon. Say "financial sustainability" or "sustaining the project" instead. Name companies like Grafana or Bitwarden as references, but drop the dollar figures—otherwise it reads as if we're chasing their numbers rather than explaining our approach.
