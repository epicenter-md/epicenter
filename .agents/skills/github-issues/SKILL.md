---
name: github-issues
description: GitHub issue comment guidelines for community interaction. Use when responding to GitHub issues, bug reports, feature requests, or any GitHub discussion.
---

# GitHub Issue & PR Comment Guidelines

## Anti-Patterns (Avoid These)

- **Over-structured responses**: Don't use headers, numbered sections, or bullet lists for simple replies. A conversational paragraph is usually better.
- **Formulaic openings**: Don't start every comment identically. Match the tone to the conversation.
- **Restating what's obvious**: If someone asked a question, just answer it. Don't recap what they said.
- **Corporate announcements**: "We are pleased to announce..." — just say what changed.

Follow [writing-voice](../writing-voice/SKILL.md) for tone.

Follow [writing-voice](../writing-voice/SKILL.md) for tone.

## Opening Pattern

Always start with a personal greeting using the user's GitHub handle:

- "Hey @username, thank you for the issue"
- "Hey everyone, thanks for the notice!"
- "Hey all, thanks for the issue!"

## Core Elements

### 1. Acknowledgment

- Start by acknowledging their issue/contribution
- Express empathy for problems: "sorry to hear this!", "sorry to hear your shortcut was lost!"
- Apologize for delays: "I apologize for the delayed response"

### 2. Good News Delivery

When announcing features or fixes:

- "good news!" or "Good news!"
- Add celebration emoji sparingly
- Credit contributors: "Thank you for the inspiration" or "Thank you and @user1 and @user2 for the inspiration"

### 3. Debugging Offers

For complex issues, offer direct help:

- "If you have time, I would love to hop on a call with you, and we can debug this together"
- "Let's hop on a call sometime in the coming days, and I'll debug it with you"
- Always include cal.com link: "https://cal.com/epicenter/whispering"
- Add availability: "I'm free as early as tomorrow"

### 4. Discord Promotion

When appropriate, mention Discord:

- "PS: I've also recently created a Discord group, and I'd love for you to join! You can ping me directly for more features."
- Include link: "https://go.epicenter.so/discord"

### 5. Follow-up Questions

Ask clarifying questions to understand the issue better:

- "To clarify, could you confirm that this issue persists even with the latest v7.1.0 installer?"
- "Did you ever get a popup to grant permission to access recording devices?"
- "Does this happen when you make recordings for more than 4 seconds?"

### 6. Closing

End with gratitude:

- "Thank you!"
- "Thanks again!"
- "Thank you again for your help and will be taking a look!"
- "My pleasure!" (when thanked)

## Response Examples

### Feature Implementation Response

```
Hey @username, thank you for the issue, and good news! [Whispering v7.1.0](link) now includes the [feature]! Thank you for the inspiration.

[Brief description of how it works]

PS: I've also recently created a Discord group, and I'd love for you to join! You can ping me directly for more features.

https://go.epicenter.so/discord
```

### Debugging Response

```
Hey @username, so sorry to hear this! I apologize for the delayed response; I was finalizing [the latest release v7.1.0](link).

To clarify, could you confirm that this issue persists even with the latest v7.1.0 installer?

If you have time, I would love to hop on a call with you, and we can debug this together. You can book a meeting with me using my cal.com link right here, I'm free as early as tomorrow:

https://cal.com/epicenter/whispering

Thank you!
```

### Quick Acknowledgment

```
Hey @username, sorry to hear [problem]! Did you ever get a fix?
```

### PR Discussion (back-and-forth)

```
Good catch! Updated to only clear the dev app cache in nuke mode.

The flow is now:
- `bun clean`: artifacts and node_modules
- `bun nuke`: above + Rust targets + dev cache

Let me know if you want a confirmation prompt before clearing.
```

## Writing Style Notes

See [writing-voice](../writing-voice/SKILL.md) for punctuation and tone guidelines.

- Use casual, approachable language
- Be genuinely enthusiastic about user contributions
- Reference specific users and give credit
- Link to relevant issues, releases, or commits
- Keep responses personal and conversational
- Avoid corporate or overly formal language
- PR comments can be brief: ongoing discussions don't need full greetings/closings
- Match the energy: short question gets short answer, detailed report gets detailed response
