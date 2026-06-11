# The Liveblocks Flatten-Diff Inversion

**TL;DR: LLMs are bad at producing structural diffs and good at producing clean rewrites. The Liveblocks approach inverts the problem: let the AI rewrite the whole thing, then algorithmically reconstruct a structured diff by flattening both versions into token sequences and running LCS. You move complexity from the LLM (bad at structure) to the algorithm (good at structure).**

> Don't ask the AI to tell you what changed. Ask it for the new version. Figure out what changed yourself.

![Liveblocks flatten-diff visualization](https://liveblocks.io/_next/image?url=%2Fimages%2Fblog%2Fbuilding-an-ai-copilot-inside-your-text-editor%2Fdiff.png&w=750&q=90)

*From Liveblocks' [Building an AI copilot inside your Tiptap text editor](https://liveblocks.io/blog/building-an-ai-copilot-inside-your-tiptap-text-editor).*

## The problem

You have a rich text editor: ProseMirror, Tiptap, Slate, whatever. The user highlights some text and asks the AI to rewrite it. Now you need a diff: what nodes were added, removed, or updated?

The obvious approach: ask the AI to produce a structured diff. Tell it the schema, give it the current document as JSON, ask for a list of operations.

This doesn't work. LLMs can't reliably produce tree operations. They lose track of node indices, miscalculate positions, and drop structural context. Even [JSON Whisperer (EMNLP 2025)](./every-ai-editor-converges-on-str-replace.md) had to eliminate array index arithmetic with stable two-character keys before LLMs could produce JSON patches, and that's for flat JSON, not nested document trees.

Every production AI editing system gave up on structural diffs and converged on text search/replace instead. But for rich text editors, you actually want structured diffs. You want to show the user "this paragraph was rewritten" and "this heading was added," not a character-level diff that splits across node boundaries.

So how do you get structural diffs without asking the AI to produce them?

## The inversion

Liveblocks describes an approach that flips the problem:

**Step 1: Constrain the output.** Give the AI a restricted markup format that mirrors your editor schema. Not arbitrary HTML: a minimal subset where every tag maps to a node type in your schema.

```
You must respond using ONLY these elements:
- <p> for paragraphs
- <h1>, <h2>, <h3> for headings
- <ul>, <ol>, <li> for lists
- <strong>, <em> for inline formatting
- <code> for inline code
```

**Step 2: Ask for a complete rewrite.** Don't ask for a diff. Don't ask for a list of changes. Ask the AI to output the entire rewritten section. LLMs are good at rewriting. They're bad at patching.

**Step 3: Flatten both documents.** Take the original document and the AI's rewrite. Flatten each into a sequence of tokens that preserves structural metadata: each token carries its text content plus the node type and attributes it belongs to.

**Step 4: Run LCS text-diff.** Classic longest common subsequence on the flattened token sequences. This is a solved problem. O(n*m) with well-known optimizations.

**Step 5: Reconstruct the structured diff.** Map the LCS result back onto the document tree. Tokens that match are "unchanged." Tokens only in the original are "removed." Tokens only in the rewrite are "added." Runs of changed tokens within the same node type are "updated."

In code, the sketch looks like:

```typescript
const originalTokens = flattenToExtendedText(editorState);
const rewriteTokens = flattenToExtendedText(parseConstrained(aiOutput));
const diff = lcsDiff(originalTokens, rewriteTokens);
const suggested = rebuildWithDiff(editorSchema, originalDoc, diff);
```

The result is a structured diff with nodes labeled as unchanged, added, updated, or removed. You can render this as a suggestion overlay: green for additions, red for removals, yellow for modifications.

## Why it works

The insight is a clean division of labor:

| Actor | Good at | Bad at |
|---|---|---|
| LLM | Producing fluent text, rewriting content | Index arithmetic, tree positions, structural invariants |
| Algorithm | Diffing sequences, matching trees, maintaining structure | Understanding intent, rewriting prose |

The flatten-diff pattern puts each actor in its zone of competence. The LLM does what it's good at (rewriting). The algorithm does what it's good at (diffing).

The constraint step is crucial. If the AI outputs arbitrary HTML with `<div>` soup and inline styles, parsing it back into your schema is a nightmare. By constraining the output to a small markup vocabulary that maps 1:1 to your schema, you guarantee that the rewrite is structurally valid. The AI doesn't need to understand your schema. It just needs to use the right tags.

## Where it works well

This pattern is ideal for the **interactive copilot** use case:

- User highlights text in the editor
- AI operates on a frozen snapshot of the document
- Changes go into a suggestion/preview layer
- User explicitly accepts or rejects

The snapshot isolation is key. While the AI is thinking, the document state (from the AI's perspective) doesn't change. There's no concurrent edit problem because the human gates the merge. If someone else edited a different part of the document, the CRDT or OT layer handles merging the accepted suggestion with those changes.

This is how Notion AI, Tiptap AI, and similar in-editor assistants work. The flatten-diff just gives you a nicer diff: node-level instead of character-level.

## Where it breaks down

The pattern struggles with **external agents** that read and write files:

**Agents output markdown, not constrained markup.** A coding agent that reads `README.md` and writes back an updated version produces markdown. Not `<p>` tags. Parsing markdown into your editor's ProseMirror schema is lossy: custom nodes, metadata, and non-standard extensions get dropped or misinterpreted.

**Independent parsing produces incompatible trees.** If you parse the original document from its CRDT state and parse the AI's output from raw markdown, you get two trees that were built by different codepaths. A paragraph with trailing whitespace might be one node in one tree and two nodes in the other. Tree-to-tree matching between independently-parsed trees is fragile.

**The concurrent deletion problem.** An agent reads a file, thinks for two minutes, writes back a version. During those two minutes, another user added a paragraph. The agent's output doesn't include that paragraph: it never saw it. The tree diff sees a deletion. The new paragraph vanishes.

With text-level diffing, this doesn't happen: the agent's changes are localized to the character ranges it actually modified, and the new paragraph survives because the agent never touched those positions. The CRDT composes the concurrent operations cleanly.

## The takeaway

The flatten-diff pattern is a genuinely clever technique for in-editor AI assistance. It gets you structural diffs. The kind users actually want to see, without asking the AI to reason about tree structure.

But it's a solution for one specific context: interactive copilots with snapshot isolation and human-gated merges. For external agents writing files concurrently with human edits, text-level operations remain the safer bet.

The deeper lesson is about designing around LLM limitations. Don't ask the model to do something it's bad at. Ask it to do something it's good at, then bridge the gap algorithmically. This applies well beyond rich text editing.

---

Related:

- [Every AI Editor Converges on str_replace](./every-ai-editor-converges-on-str-replace.md): The industry-wide convergence on text search/replace
- [Two Kinds of AI Editing](./two-kinds-of-ai-editing.md): Why interactive copilots and external agents need different solutions
- [Why LLMs Can't Do Tree Operations](./why-llms-cant-do-tree-operations.md): The fundamental constraint behind all of this
