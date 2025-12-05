# Documentation & README Writing Guidelines

## Voice Matching Priority

When the user provides a voice transcript, tone guidance, or example text to match, that takes priority over all other rules below. Match their voice exactly:

- If they start with "In Epicenter, we use X", start with that. Don't add a story preamble.
- If their example is 5 sentences, aim for similar brevity. Don't expand to 5 paragraphs.
- If they use direct statements, don't convert to narrative ("I used to... then I realized...").

Not every article needs a story arc. Some are just direct statements of practice. Match the user's intent.

## Technical Writing Voice

### Core Principles

- **Start with the problem or decision**: "I was building X and hit this decision" not "When building applications..."
- **Show the insight first**: Lead with what you realized, then explain why
- **Use concrete examples**: Show actual code or scenarios, not abstract concepts
- **Make it conversational**: Write like you're explaining to a colleague at lunch

### Sentence Structure

- **Short, punchy observations**: "That's it. No Result types. No error handling dance."
- **Build rhythm**: Mix short sentences with longer explanations
- **Use fragments for emphasis**: "Every. Single. Operation."
- **Ask the reader's unspoken question**: "But why all this complexity for localStorage?"

### Technical Explanations

- **Explain the 'why' before the 'how'**: "localStorage is synchronous. Why am I adding async complexity?"
- **Call out the obvious**: "Here's the thing that took me too long to realize"
- **Use comparisons**: "I was treating localStorage like a remote database. But it's not."
- **End with the lesson**: Not generic advice, but what YOU learned

### Avoiding Academic/Corporate Tone

- Don't: "This article explores two architectural approaches..."
- Do: "I hit an interesting architectural decision"
- Don't: "Let's examine the implications"
- Do: "Here's what I mean"
- Don't: "In conclusion, both patterns have merit"
- Do: "The lesson: Not every data access needs a service"

## Authentic Communication Style

- Avoid emojis in headings and formal content unless explicitly requested
- Use direct, factual language over marketing speak or hyperbole
- Lead with genuine value propositions, not sales tactics
- Mirror the straightforward tone of established sections when editing
- Prefer "I built this because..." over "Revolutionary new..."

## Open Source Mindset

- Emphasize user control and data ownership
- Highlight transparency benefits (audit the code, no tracking)
- Focus on direct relationships (user → provider) over middleman models
- Present honest cost comparisons with specific, real numbers
- Acknowledge limitations and trade-offs openly

## Avoiding AI-Generated Feel

### The Dead Giveaways

- **Bold formatting everywhere**: Biggest red flag. Never bold section headers in post content
- **Excessive bullet lists**: Convert to flowing paragraphs
- **Marketing language**: "game-changing", "revolutionary", "unleash", "empower"
- **Structured sections**: "Key Features:", "Benefits:", "Why This Matters:"
- **Vague superlatives**: "incredibly powerful", "seamlessly integrates", "robust solution"
- **AI adjectives**: "perfectly", "effortlessly", "beautifully", "elegantly"

### Writing Natural Prose

- **Start with a story or problem**: "I was paying $30/month..." not "Introducing..."
- **Use specific numbers**: "$0.02/hour" not "affordable pricing"
- **Personal voice**: "I built this because..." not "This was built to..."
- **Conversational flow**: Ideas connect naturally, not in rigid sections
- **Concrete examples**: "I use it 3-4 hours daily" not "heavy usage"

### Code Examples in Articles

- **Trim to essentials**: Show the pattern, not every implementation detail
- **Add inline observations**: "Notice how every operation returns a Result type"
- **Compare approaches side-by-side**: Keep code minimal but complete enough to understand
- **Comment on the experience**: "That's a lot of ceremony for localStorage"

### The OpenAI Post Pattern (What Works)

```
Personal hook → Specific problem → Real numbers → How I solved it →
What it actually does → Technical details → Genuine question to community
```

### Paragraph Structure

- Mix short and long sentences
- One idea flows into the next
- No rigid formatting or sections
- Natural transitions like "So I built..." or "Here's the thing..."
- End with engagement, not a sales pitch

## README Structure Principles

- Start with what the tool actually does, not why it's amazing
- Use honest comparative language ("We believe X should be Y")
- Present facts and let users draw conclusions
- Include real limitations and use cases
- Make pricing transparent with actual provider costs

# Punctuation Guidelines

## Avoiding AI Artifacts

The pattern " - " (space-hyphen-space) is a common AI writing artifact that should be replaced with proper punctuation.

### Replacement Priority

1. **Semicolon (;)**: Use to connect closely related independent clauses
   - Before: `The code works - the tests pass`
   - After: `The code works; the tests pass`

2. **Colon (:)**: Use when introducing an explanation, list, or example
   - Before: `**Bold text** - This explains what it means`
   - After: `**Bold text**: This explains what it means`

3. **Em dash (—)**: Use for dramatic pauses or parenthetical statements where semicolon and colon don't work
   - Before: `The app is fast - really fast`
   - After: `The app is fast—really fast`

### Common Patterns

- **Definitions/Explanations**: Use colon
  - `**Feature name**: Description of the feature`
- **Examples/Lists**: Use colon
  - `**Examples**: item1, item2, item3`
- **Dramatic emphasis**: Use em dash
  - `It's more than fast—it's instant`
- **Related statements**: Use semicolon
  - `The API is simple; the documentation is clear`

# README and Documentation Guidelines

## Focus on "Why", Not "What"

READMEs and documentation should explain design decisions and organizational principles, not duplicate information that's already visible in the codebase.

### Avoid

- Directory structure listings (users can see this with `ls`)
- Exhaustive lists of current files or providers (creates maintenance burden)
- Obvious information that's self-evident from reading the code
- Implementation details better expressed in code comments

### Include

- Reasoning behind organizational choices
- Architectural principles that aren't obvious from structure alone
- Conceptual groupings and their purposes
- Trade-offs and design decisions

### Example: Good README

```markdown
# Transcription Services

This directory organizes transcription providers by deployment model.

## Organization

### `/cloud`

API-based services that send audio to external providers. These require API keys and an internet connection.

### `/local`

On-device processing that runs entirely on the user's machine. These require downloading model files but work offline.

### `/self-hosted`

Services that connect to servers you deploy yourself. You provide the base URL of your own instance.
```

### Example: Bad README

```markdown
# Transcription Services

## Directory Structure

- `/cloud`
  - `openai.ts`: OpenAI Whisper API
  - `groq.ts`: Groq transcription
  - `deepgram.ts`: Deepgram API
    [... exhaustive listing of every file]
```

The good example explains the reasoning (deployment model categorization) without listing specifics. The bad example duplicates what's already visible and requires updates whenever files change.

# Writing Style Examples

## Good Example (Natural, Human)

```markdown
"I was paying $30/month for a transcription app. Then I did the math: the actual API calls cost about $0.36/hour. At my usage (3-4 hours/day), I was paying $30 for what should cost $3.

So I built Whispering to cut out the middleman. You bring your own API key, your audio goes directly to the provider, and you pay actual costs. No subscription, no data collection, no lock-in."
```

## Bad Example (AI-Generated Feel)

```markdown
"**Introducing Whispering** - A revolutionary transcription solution that empowers users with unprecedented control.

**Key Benefits:**

- **Cost-Effective**: Save up to 90% on transcription costs
- **Privacy-First**: Your data never leaves your control
- **Flexible**: Multiple provider options available

**Why Whispering?** We believe transcription should be accessible to everyone..."
```

## The Difference

- Good: Tells a story, uses specific numbers, flows naturally
- Bad: Structured sections, bold headers, marketing language
- Good: "I built this because..." (personal)
- Bad: "This was built to..." (corporate)
- Good: "$0.02/hour" (specific)
- Bad: "affordable pricing" (vague)
