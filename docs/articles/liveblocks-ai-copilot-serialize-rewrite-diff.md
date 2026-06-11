# How Liveblocks Built an AI Copilot by Serializing to Custom JSX and Diffing the Rewrite

**TL;DR**: Liveblocks doesn't ask the LLM to produce edit operations. They serialize the document to a custom JSX-like format, let the LLM rewrite the whole thing, then diff the result themselves. The serialization format is the key design decision.

> "LLMs are great at rewriting but terrible at patching. Once we gave it a strict language and compared outputs ourselves, everything clicked."

If you're building AI editing into a rich text editor, [Liveblocks' writeup on building an AI copilot inside TipTap](https://liveblocks.io/blog/building-an-ai-copilot-inside-your-tiptap-text-editor) is the most detailed production walkthrough I've found. Not a demo. Not a concept. A real system shipping in their product, Distribute, with collaboration, streaming, and a human-in-the-loop review flow.

Here's what makes their approach worth studying.

## The Core Insight: Serialize, Rewrite, Diff

Most people's first instinct is to ask the LLM to generate edit operations. "Delete the third paragraph, insert a heading before the list, bold these words." That fails because LLMs can't track positions in a tree. They don't have a mental model of how deleting node A shifts the position of node B.

Liveblocks inverted the problem. Instead of asking the LLM to produce a diff, they ask it to produce a complete rewritten document. Then they compute the diff algorithmically.

The three-step pipeline:

1. **Serialize** the current document to a custom JSX-like markup
2. **Send it to the LLM** with the user's instruction and get back a full rewrite in the same format
3. **Diff the original and rewritten markup** using an extended-text diffing algorithm

The LLM never touches ProseMirror operations. It never computes positions. It just rewrites text in a format it understands. All the precision work happens in deterministic code.

## The Custom JSX Format

This is the design decision that makes everything work. Liveblocks defined a restricted markup language that mirrors their editor schema exactly. Not HTML. Not markdown. A purpose-built format.

```jsx
<Doc>
  <Tab id="tab1" name="Overview">
    <Heading level="1">Project Summary</Heading>
    <Paragraph>
      This is <Bold>important</Bold> context about the project.
    </Paragraph>
    <BulletList>
      <ListItem>First deliverable</ListItem>
      <ListItem>Second deliverable</ListItem>
    </BulletList>
    <CustomLink href="https://example.com">Reference</CustomLink>
  </Tab>
</Doc>
```

The vocabulary is fixed and explicit:

| Category | Tags |
|----------|------|
| Structure | `<Doc>`, `<Tab id="x" name="Y">` |
| Text blocks | `<Paragraph>`, `<Heading level="1-3">`, `<HardBreak>` |
| Formatting | `<Bold>`, `<Italic>`, `<Strike>`, `<Underline>` |
| Lists | `<BulletList>`, `<OrderedList>`, `<ListItem>` |
| Special | `<CustomLink href="...">`, `<CustomImage src="...">` |
| Protected | `<ContactCard>`, `<CustomTaskList>`, `<Button>`, `<VideoRecord>` |

The "Protected" category is crucial. The system prompt tells the LLM these blocks exist in the document but must never be modified. Contact cards, task lists, buttons, video embeds. The LLM sees them but can't touch them. This preserves complex interactive elements that would break if an LLM tried to rewrite them.

Why not markdown? Markdown can't express `<Tab>`, `<ContactCard>`, or `<CustomLink>` with specific attributes. Why not HTML? HTML is verbose, and LLMs occasionally produce malformed HTML with missing closing tags. The custom format is compact, mirrors the schema exactly, and LLMs handle it well because it looks like JSX. Something they've seen millions of times in training data.

## The Extended-Text Diffing Algorithm

Once the LLM returns a rewritten document, Liveblocks needs to show a diff. But you can't just run a standard text diff on two trees. Their solution: flatten both documents into token sequences while preserving structural metadata.

![Liveblocks' extended-text diffing diagram showing how documents are flattened to tokens, diffed, then reconstructed](https://liveblocks.io/_next/image?url=%2Fimages%2Fblog%2Fbuilding-an-ai-copilot-inside-your-text-editor%2Fdiff.png&w=750&q=90)

The process works in three stages:

**Flatten**: Each document becomes a sequence of tokens. Characters become individual tokens. Structural elements become special marker tokens. End-of-block (EOB), image placeholders (IMG), horizontal rules (HR), mentions (MENTION). Each token carries metadata about which node it belongs to and what marks apply.

**Diff**: Run a classical Longest Common Subsequence algorithm on the two token sequences. This is the same core algorithm git uses for text diffs, but operating on tokens that carry structural context.

**Reconstruct**: Walk the diff output and label every node in the tree as `unchanged`, `added`, `updated`, or `removed`. Because each token knows which node it belongs to, you can reconstruct a tree-level semantic diff from a flat token-level comparison.

This hybrid approach gives you the reliability of text diffing (a solved problem) with the semantic awareness of tree comparison. You're not diffing characters in a vacuum. You're diffing tokens that know their place in the document structure.

## Streaming Without False Deletions

There's a subtle UX problem with streaming. While the LLM is still generating tokens, everything after the current position looks like it was deleted. If you naively diff the partial output against the original document, the user sees massive red deletions flickering at the bottom.

Liveblocks' fix: suppress trailing removal fragments during streaming. While the LLM is writing, only show additions and updates. The diff view shows the rewrite propagating forward through the document. When the stream completes, reveal the full diff including any actual deletions.

This keeps the preview stable. Users see content being rewritten progressively, not a constantly shifting wall of red and green.

## The Collaboration Model

AI changes stay local. When a user invokes the copilot, their editor switches to a read-only diff view. The proposed changes exist only on that user's machine. Meanwhile, other collaborators keep editing normally. Their changes sync through Liveblocks' real-time infrastructure and appear in the diff preview.

The diff is computed against the live document state, not a frozen snapshot. If User B edits a paragraph while User A is reviewing AI changes, User A's diff updates to reflect B's edit. When User A accepts, the AI changes apply as normal collaborative transactions, authored by User A.

If User A rejects, nothing happens. No one else ever knew AI was involved.

## The Full Pipeline

```
User clicks "Rewrite"
       │
       ▼
┌─────────────────────────┐
│ Serialize current doc    │
│ to custom JSX format     │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ Send to LLM:            │
│ - JSX document           │
│ - Document metadata      │
│ - User instruction       │
│ - System prompt w/ rules │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ LLM returns JSON:        │
│ {                        │
│   doc: "<Doc>...</Doc>", │
│   comment: "I changed…"  │
│ }                        │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ Extended-text diff:      │
│ flatten → LCS → rebuild  │
│ (suppress trailing       │
│  removals while stream)  │
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ Show diff preview:       │
│ unchanged / added /      │
│ updated / removed        │
│ [Accept] [Reject] [Chat] │
└────────────┬────────────┘
             │
        User accepts
             │
             ▼
┌─────────────────────────┐
│ Apply as Yjs/Liveblocks  │
│ transactions (authored   │
│ by requesting user)      │
└─────────────────────────┘
```

## Why This Approach Wins

The custom JSX format is doing most of the heavy lifting. It solves three problems at once:

1. **Fidelity**: Every node type in the schema has a corresponding tag. Custom nodes, attributes, marks. Nothing gets lost in translation.
2. **LLM compatibility**: The format looks like JSX/XML, which LLMs handle well from training. They don't need to learn a novel syntax.
3. **Diffability**: Because the format is structured and consistent, the flattening step produces clean token sequences that diff reliably.

Markdown would lose custom nodes. HTML would be verbose and error-prone. Raw JSON would be unusable as LLM output. The constrained JSX format sits in the sweet spot: expressive enough for the schema, familiar enough for the LLM, structured enough for algorithmic diffing.

## The Golden Rule

**Don't ask LLMs to be precise. Ask them to be complete, then extract precision yourself.** Liveblocks' entire architecture is built on this principle. The LLM rewrites freely in a constrained format. The algorithm computes the diff precisely. Each component does what it's good at.

The serialization format is the contract between these two worlds. Get it right and everything downstream works. Get it wrong and no amount of prompt engineering saves you.

## References

- [Building an AI Copilot Inside Your TipTap Text Editor](https://liveblocks.io/blog/building-an-ai-copilot-inside-your-tiptap-text-editor): the full Liveblocks writeup
- [Liveblocks AI Documentation](https://liveblocks.io/docs/ai): API reference for their AI features
