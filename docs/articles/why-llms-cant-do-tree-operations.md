# Why LLMs Can't Do Tree Operations

**TL;DR: LLMs are sequence models that predict the next token from all previous tokens. Tree operations require maintaining structural invariants: parent-child relationships, sibling indices, depth-aware positioning: while generating tokens left to right. This is fundamentally at odds with how transformers work. The evidence: every production AI editing system gave up on tree operations and converged on text search/replace.**

> You wouldn't ask a human to edit a document by specifying byte offsets. Stop asking LLMs to edit documents by specifying tree positions.

## The fundamental mismatch

A transformer takes a sequence of tokens and predicts the next one. That's it. Everything else: conversations, code generation, reasoning: is an emergent property of next-token prediction over a large enough training corpus.

This architecture is phenomenal at producing text that looks like text. It's bad at producing structured data that requires maintaining invariants across the output.

A tree operation looks like this:

```json
{
  "op": "insert",
  "path": "/body/children/2",
  "node": { "type": "paragraph", "text": "New paragraph" }
}
```

To produce this correctly, the model needs to:

1. Parse the current document tree from its context window
2. Navigate to the right parent node
3. Count the children to determine the correct index
4. Ensure the index is valid (not -1, not past the end)
5. Produce a node that conforms to the schema at that position
6. Get all of this right in a single autoregressive pass

Steps 2-4 are index arithmetic. The model has to look at the tree, count nodes, and output a number. Transformers are unreliable at counting. They approximate. A tree with 15 children looks a lot like a tree with 14 children to a model that's pattern-matching over token sequences.

And that's a single operation. A typical edit involves multiple operations that interact:

```json
[
  {"op": "remove", "path": "/body/children/5"},
  {"op": "insert", "path": "/body/children/3", "node": {...}},
  {"op": "replace", "path": "/body/children/7/text", "value": "updated"}
]
```

After removing index 5, what was index 7 is now index 6. The model has to track these cascading shifts while generating each operation. This is the same class of problem as pointer arithmetic in C: technically possible, practically a source of endless bugs, even for humans.

## The JSON Whisperer evidence

The most rigorous study of this problem is JSON Whisperer (EMNLP 2025). Researchers tried having LLMs output RFC 6902 JSON Patch. The standard format for JSON diffs. The format is simple:

```json
[
  {"op": "add", "path": "/items/2", "value": "new"},
  {"op": "remove", "path": "/items/5"},
  {"op": "replace", "path": "/name", "value": "updated"}
]
```

LLMs failed specifically at array operations. They could handle object key paths (`/name`, `/config/theme`) fine. Those are string lookups, not arithmetic. But array index paths (`/items/2`, `/children/5`) were unreliable. The model would output index 3 when it meant 4, or fail to account for shifts after a remove.

The researchers' solution: EASE encoding. Replace array indices with stable two-character keys:

```json
// Before (LLMs struggle):
{"op": "remove", "path": "/items/3"}

// After EASE encoding (LLMs handle):
{"op": "remove", "path": "/items/Bc"}
```

`Bc` doesn't shift when you remove `Aa`. There's no arithmetic. The model treats it as a string identifier, which it can copy reliably from context.

This worked. But only for JSON. And only after eliminating the exact thing that makes tree operations hard: positional arithmetic.

## What doesn't work in practice

Here's a non-exhaustive list of structured output formats that nobody has successfully shipped for AI editing:

**ProseMirror transactions.** A ProseMirror step specifies a position (character offset into the flattened document), a slice (the content to insert), and optional marks. Getting the position right requires understanding ProseMirror's flattened indexing scheme, where node boundaries count as positions. Models routinely get positions off by 1-3.

**Yjs CRDT operations.** Yjs operations reference internal item IDs (client ID + clock), which are opaque to the LLM. Even if you exposed a friendlier API, the operations need to reference specific positions within the CRDT's internal linked list. The model can't see this structure.

**AST transformations.** "Wrap the third statement in the function body with a try-catch" requires parsing the AST, navigating to the right node, and producing a valid transformation. Models get close but break on edge cases: wrong nesting level, incorrect scope boundaries, missing closing delimiters.

**Tree diffs.** "Add node X as child 3 of node Y, then move node Z from under node A to under node B." Every operation depends on the tree state after previous operations. Cascading index shifts make this intractable for current models.

## What works instead

Every production system converges on the same workaround: treat the document as text.

**Text search/replace**: Claude Code's `str_replace(old_string, new_string)`, Aider's SEARCH/REPLACE blocks, Cursor's semantic diffs. The model finds text by matching content, not by navigating a tree. The surrounding text is the anchor.

**Complete rewrites with algorithmic diffing**: Liveblocks' [flatten-diff approach](./liveblocks-flatten-diff-pattern.md). Don't ask the model for a diff. Ask it to rewrite the whole section. Then diff algorithmically. Move the structural reasoning from the model (bad at it) to a deterministic algorithm (good at it).

**Line-level operations**: OpenAI Codex uses `*** Begin Patch` with line-context markers. Not byte positions or tree paths. The model identifies lines by their content, then specifies insertions and deletions relative to those content anchors.

The common thread: the model works with text as text. It identifies locations by content, not by position. It produces text, not operations. The system around it translates text changes into whatever structured operations the underlying data model needs.

## The deeper lesson

The problem isn't that LLMs are "dumb." GPT-4, Claude, and Gemini are staggeringly capable at language tasks. The problem is interface mismatch.

Tree operations are a machine interface. They were designed for programs that maintain perfect state, can index arrays without error, and track cascading position changes flawlessly. Asking an LLM to produce them is like asking a human to hand-write TCP packets. We can technically do it. We'll get it wrong constantly.

Text search/replace is a human interface. Find this chunk of text. Replace it with that chunk of text. This is how humans describe edits to each other. It's also how LLMs work best. They find patterns in text and produce new text.

The best AI editing systems don't fight this. They lean into it. They let the model work with text, and they handle the translation to structural operations in deterministic code that won't hallucinate an off-by-one.

## The takeaway

If you're designing a system that AI will edit, don't expose tree operations to the model. Expose text. Let the model read text and write text. Translate between text and your internal representation in code, not in the prompt.

This isn't a temporary limitation that will be fixed with the next model generation. It's a consequence of the transformer architecture. Next-token prediction is good at text and bad at positional arithmetic. That won't change until the architecture does.

---

Related:

- [Every AI Editor Converges on str_replace](./every-ai-editor-converges-on-str-replace.md): The industry-wide convergence that proves this point
- [The Liveblocks Flatten-Diff Inversion](./liveblocks-flatten-diff-pattern.md): The best workaround for when you need structural diffs
- [Two Kinds of AI Editing](./two-kinds-of-ai-editing.md): Why the copilot and the agent need different approaches
