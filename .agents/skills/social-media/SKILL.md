---
name: social-media
description: 'Post copy guidelines for LinkedIn, Reddit, Twitter/X. Use when: "post on LinkedIn", "write a tweet", "draft a Reddit post", drafting final announcement copy. For turning an artifact into multi-platform content, use content-distribution; this skill owns the final post copy.'
metadata:
  author: epicenter
  version: '1.0'
---

# Social Media Post Guidelines

Follow [writing-voice](../writing-voice/SKILL.md) for tone.

## Platform-Specific Brevity

- **LinkedIn**: 3-5 lines max. State the feature, drop the link, done.
- **Twitter/X**: Each tweet should have ONE idea. Don't overexplain.
- **Reddit technical subs**: Focus on implementation details, not benefits

## What to Remove

- All hashtags except when platform culture expects them
- Section headers in post content ("## Implementation", "## Benefits")
- Bullet lists of features/benefits
- Marketing phrases ("game-changing", "seamless", "powerful")
- Call-to-action phrases ("See it in action!", "Try it today!")
- Redundant adjectives ("excellent", "really")

## What to Add

- Specific technical details that developers care about
- Actual implementation challenges and solutions
- Links to relevant libraries/APIs used
- One concrete detail that makes the feature distinct
- A non-affiliation disclaimer when recommending someone else's tool
- Honest personal opinions, including admissions that code is rough or unfinished
- Proper punctuation for transitions (semicolons, periods; not space-hyphens)

## Examples: Twitter/X

For a feature announcement, one tweet is the whole post: what shipped, what it does in plain verbs, one link. No emoji framing, no hashtags, no "try it now."

### Single Tweet (Technical Insight)

Good:

```
TIL: Tauri's onDragDropEvent works where web drag-and-drop doesn't. If you're building a desktop app with web tech, native drag-and-drop is ~20 lines and handles file paths the OS way.
```

Bad:

```
Just discovered something amazing about Tauri! 🤯

Their native drag-and-drop API is incredibly powerful and seamlessly handles file operations that web APIs simply can't match.

This is why I love building with Tauri! 💪
```

The difference: the good tweet teaches something specific. The bad tweet expresses enthusiasm about nothing in particular.

### Thread Structure (2-4 tweets max)

When a single tweet isn't enough, use a short thread. Each tweet should be self-contained enough to make sense if someone sees it in isolation.

Good:

```
Tweet 1:
Built a CRDT-based table storage that's 1935x smaller than Y.Map for the same data. The trick: store cells as "rowId:colId" keys in a flat array with LWW timestamps.

Tweet 2:
Y.Map creates one CRDT entry per key, each with metadata overhead. A flat YKeyValue array stores raw entries with timestamps; conflict resolution happens in userland. 524KB → 271 bytes for a 50-row table.

Tweet 3:
Trade-off: you lose Y.Map's built-in observe() granularity. We rebuilt it with a CellStore layer that parses keys and emits typed change events. Worth it for the storage savings.

Source: github.com/EpicenterHQ/epicenter
```

Bad:

```
Tweet 1:
🧵 Thread: How we achieved a massive 1935x improvement in our CRDT storage! Let me walk you through our journey...

Tweet 2:
First, let's understand the problem. Y.Map is great but creates significant overhead...

Tweet 3:
So what did we do? We implemented an innovative approach using...

Tweet 4:
The results were absolutely incredible! Here are the key benefits:
- 1935x smaller storage
- Faster sync times
- Better conflict resolution

Tweet 5:
If you found this helpful, please RT and follow for more content like this! 🙏
```

The good thread: each tweet has a concrete fact. The bad thread: tweet 1 is a hook, tweet 2 is setup, and the information doesn't start until tweet 3. The "please RT" closer is an instant credibility loss.

## Examples: LinkedIn Posts

### Good (Actual Human Post)

This is one past Whispering post, kept as an example of the shape (feature, plain mechanics, link, done), not a template to reuse.

```
Whispering now supports direct file uploads!

Simply drag and drop (or click to browse) your audio files for instant transcription, with your model of choice.

Free open-source app: https://github.com/EpicenterHQ/epicenter
```

### Bad (AI-Generated Feel)

```
Excited to announce that Whispering now supports direct file uploads!

This game-changing feature allows you to:
- Drag and drop any audio/video file
- Get instant, accurate transcriptions
- Save time and boost productivity

Built with the same philosophy of transparency and user control, you pay only actual API costs (just 2c/hour!) with no hidden fees or subscriptions.

Ready to revolutionize your workflow? Try it now!

GitHub: https://github.com/EpicenterHQ/epicenter

#OpenSource #Productivity #Innovation #DeveloperTools #Transcription
```

## Examples: Reddit Technical Posts

### Good (Focused on Implementation)

Write it like a build log from a peer, not an announcement. Greet the sub, say what you shipped and how: name the exact library or component, show one short real code snippet, link the upstream docs, and describe the problem you hit and the fix. Admit honest caveats about the code's state, link the full implementation, disclose non-affiliation when recommending a tool, and close by inviting implementation questions.

### Bad (Marketing-Focused)

```
## The Problem
Users were asking for file upload support...

## The Solution
I implemented a beautiful drag-and-drop interface...

## Key Benefits
- User-friendly interface
- Supports multiple file formats
- Lightning-fast processing

## Why This Matters
This transforms the user experience...
```
