# TipTap Ships the Primitives So You Don't Have to Build the Diff Engine

**TL;DR**: TipTap now handles the hard parts of AI editing. Document diffing, schema-aware agents, and streaming integration. So you can wire up an LLM without rebuilding ProseMirror infrastructure.

> "Make sure the stream returns HTML to render directly as rich text."

I was looking at what it would take to add AI editing to a TipTap editor. The obvious part is calling an LLM. The hard part is everything else: comparing documents to show inline diffs, streaming changes without breaking the schema, managing selection state while an agent rewrites content. TipTap just shipped all of that.

## The AI Agent: Split Brain and Hands

The agent architecture is client-server. The LLM runs on your server as the "brain". The TipTap extension runs in the browser as the "hands and eyes." The extension knows how to read the current document, rewrite specific parts, and respect the editor's schema. The agent gets built-in tools for reading content, rewriting selections, planning, and summarization. It's selection-aware and schema-aware by default.

This matters because ProseMirror schemas are strict. You can't just paste arbitrary HTML into a document and hope it works. The agent respects node types, marks, and attributes defined in your schema.

```
┌─────────────────┐          ┌─────────────────┐
│   Browser       │          │   Server        │
│                 │          │                 │
│  TipTap Agent   │ ◄──────► │   LLM Brain     │
│  Extension      │   HTTP   │   (OpenAI/etc)  │
│  (hands/eyes)   │          │                 │
└─────────────────┘          └─────────────────┘
       │
       ▼
  ProseMirror
  Document State
```

## The Diff Utility: Four Ways to Compare

The diff utility compares two ProseMirror documents and returns a list of changes. You get four modes:

| Mode           | What it does                    | Best for                  |
|----------------|---------------------------------|---------------------------|
| detailed       | Character-level                 | Precise text changes      |
| block          | Top-level nodes as units        | Paragraph-level changes   |
| smartInline    | Changed blocks first, inline    | Balance of precision/perf |
| smartInlineV2  | Improved for block elements     | Tables, complex blocks    |

The default is detailed. If you're showing changes in a document with lots of nested structure. Tables, code blocks, lists. SmartInlineV2 handles those better. Block mode treats entire paragraphs as atomic units, which is faster but less precise.

You can configure how changes merge together. The changeMergeDistance option controls how close two changes need to be before they combine into one. You can also ignore specific attributes or marks if you don't care about formatting changes.

For real-time inline diffs, use startComparingDocuments(). It has a 500ms debounce so it doesn't recalculate on every keystroke. This is how you show live comparison between a user's draft and an AI suggestion.

## Content AI Generation: Bring Your Own LLM

TipTap gives you three resolver functions to wire up your LLM:

- aiCompletionResolver: non-streaming responses
- aiStreamResolver: streaming responses
- aiImageResolver: image generation

The critical detail here is that TipTap expects HTML back, not markdown. The docs say it explicitly: "Make sure the stream returns HTML to render directly as rich text." If your LLM outputs markdown, you need to convert it before passing it to TipTap. That's where the markdown package comes in.

## The Markdown Package: Bidirectional Conversion

The @tiptap/markdown package handles markdown conversion via MarkdownManager. You get two methods:

- editor.getMarkdown(): exports current document to markdown
- editor.commands.setContent(markdown, { contentType: 'markdown' }): imports markdown into the editor

It uses marked.js under the hood. This is open source, unlike the AI primitives. If your LLM outputs markdown, you can convert it before streaming it into the editor.

## Integration with Yjs: AI Changes Are Just Transactions

If you're using Yjs and Hocuspocus for collaboration, AI changes work the same way as user edits. The AI agent applies changes through ProseMirror transactions. Yjs intercepts those transactions and syncs them to other clients. You don't need special handling for AI edits versus human edits.

## What's Pro and What's Open Source

Here's the licensing breakdown:

| Feature           | License      |
|-------------------|--------------|
| AI Agent          | Pro          |
| Content AI        | Pro          |
| AI Toolkit        | Pro          |
| Diff Utility      | Pro          |
| Markdown Package  | Open Source  |

The markdown package is the only part you can use without a TipTap Pro license. Everything else requires Pro: the agent, diff utility, and generation resolvers.

## Why This Matters

The hard part of AI editing isn't calling an LLM. It's all the infrastructure around it: diffing documents without breaking schemas, streaming changes while respecting node boundaries, managing selection state during rewrites. TipTap built all of that and shipped it as primitives.

You still need to bring your own LLM and write the resolver functions. But you don't need to rebuild the diff engine or figure out how to stream HTML into a ProseMirror document without breaking things. That's already done.

**The Golden Rule**: AI editing is just ProseMirror transactions with extra steps. TipTap handles the extra steps so you can focus on the LLM part.

## Trade-offs

This is Pro-only except for markdown conversion. If you're building a free or open-source editor, you'll need to implement diffing and streaming yourself.

The architecture assumes client-server split. If you're running an LLM entirely client-side. Like with WebLLM or a local model. You still need to follow the agent pattern. You can't skip the extension layer.

The streaming resolver expects HTML. If your LLM outputs markdown, you need the conversion step. That's an extra dependency and processing overhead.

## When to Use This

You're building an editor with AI features and you're already using TipTap. You don't want to spend time building document comparison or streaming infrastructure. You're okay with the Pro license cost. You need schema-aware editing that works with collaboration.

## When Not to Use This

You're building a free or open-source editor and can't afford Pro licensing. You're using a different editor framework and don't want to switch. You need more control over the diff algorithm or streaming behavior than TipTap exposes.

You're running everything client-side and don't want the overhead of the agent pattern.

## Three Quotable Moments

> "The hard part of AI editing isn't calling an LLM. It's all the infrastructure around it."

> "AI editing is just ProseMirror transactions with extra steps. TipTap handles the extra steps."

> "TipTap expects HTML back, not markdown. If your LLM outputs markdown, you need to convert it before streaming."

## References

- AI Agent Overview: https://tiptap.dev/docs/content-ai/capabilities/agent/overview
- Diff Utility: https://tiptap.dev/docs/content-ai/capabilities/ai-toolkit/primitives/diff-utility
- Custom LLMs: https://tiptap.dev/docs/content-ai/capabilities/generation/custom-llms
