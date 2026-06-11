# LLMs Can't Diff Trees: Let Them Rewrite, Then Diff It Yourself

**TL;DR**: LLMs are terrible at producing structured tree diffs but excellent at rewriting complete documents. Invert the problem: constrain the output format, let the LLM rewrite everything, then **you diff the result algorithmically**.

> "LLMs are great at rewriting but terrible at patching.": Liveblocks

## The Problem

I was reading Liveblocks' article on building an AI copilot for TipTap, and they nailed something I'd been circling around for months. ProseMirror uses a strict tree-based document model. Every node has a type. Every mutation validates against a schema. You can't just splice text into the middle like you would with a string.

Here's the thing: LLMs are trained on flat text. When you ask GPT-4 to edit a paragraph, it's thinking in tokens, not tree nodes. It can rewrite your whole document beautifully. But ask it to produce a ProseMirror transaction with precise positions and node types? It falls apart.

You get broken references. Lost structure. Operations that reference positions that don't exist anymore. The LLM has no mental model of how its edits affect subsequent positions in the tree.

## The Naive Approaches That Fail

First instinct: ask the LLM for ProseMirror transactions directly. "Generate the operations needed to transform this document." It tries. It generates something that looks plausible. Then you apply it and the document corrupts because position 47 doesn't exist after the deletion at position 12.

Second attempt: JSON patches. Same problem, different format. The LLM doesn't understand that inserting a node shifts all subsequent paths.

Third try: edit operations with positions. "Delete characters 10-15, insert 'hello' at position 22." But which positions are we talking about? Before the edits or after? The LLM can't track this consistently.

## The Breakthrough

Liveblocks figured out the answer: stop asking the LLM to diff. It's not good at that. It's good at rewriting.

Let it rewrite the entire document in a constrained format. Then you compute the diff yourself using reliable algorithms.

Here's their three-step process.

### Step 1: Constrain the Output Format

Instead of free-form text, define a restricted markup language that mirrors your schema. For TipTap, that's JSX-style tags: `<Doc>`, `<Paragraph>`, `<Bold>`, `<Italic>`, etc.

The system prompt is strict. It defines what tags exist. It shows examples. It forbids modifying certain block types (like tables or code blocks that need special handling).

The LLM can now express structure, but in a format it understands: markup it's seen millions of times during training.

### Step 2: LLM Rewrites the Full Document

You give the LLM the current document serialized to this markup format. You give it the user's edit instruction. It outputs a complete rewritten document in the same markup format.

Not a diff. Not a patch. The whole thing.

This plays to the LLM's strengths. It's rewriting text with structural hints. That's basically what it does when generating HTML or Markdown.

### Step 3: Diff Algorithmically

Now you have two documents in the same format: the original and the LLM's rewrite. Both are valid. Both follow the schema.

You flatten both to token sequences while preserving structural metadata (which node each token belongs to, what marks apply). Then you run a Longest Common Subsequence diff, the same algorithm git uses for text.

The output is a sequence of operations: unchanged, added, updated, removed. These are semantic labels you can trust because you computed them yourself.

Now you can reconstruct ProseMirror transactions that transform the original tree into the target tree, respecting schema validation at every step.

```
┌─────────────┐
│  Doc Tree   │
└──────┬──────┘
       │ Serialize to JSX
       ▼
┌─────────────────────┐
│ <Doc><Para>...</>   │
└──────┬──────────────┘
       │ Send to LLM with instruction
       ▼
┌─────────────────────┐
│ LLM rewrites full   │
│ doc in same format  │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐     ┌─────────────────────┐
│  Original tokens    │     │  Rewritten tokens   │
│ [metadata intact]   │     │ [metadata intact]   │
└──────┬──────────────┘     └──────┬──────────────┘
       │                            │
       └────────────┬───────────────┘
                    │ LCS diff
                    ▼
          ┌──────────────────┐
          │ unchanged/added/ │
          │ updated/removed  │
          └────────┬─────────┘
                   │ Reconstruct operations
                   ▼
          ┌──────────────────┐
          │ Apply to tree    │
          └──────────────────┘
```

## The Streaming Challenge

There's a subtle problem with streaming the LLM's output. While the model is still generating text, it looks like everything after the cursor has been deleted. If you naively diff the partial output against the original, you'll show massive trailing deletions that aren't real; they're just not written yet.

Liveblocks' solution: suppress trailing removals during streaming. Only show additions and updates while the LLM is writing. When the response completes, reveal the full diff including deletions.

This keeps the UI stable. Users see the rewrite propagating forward through the document, not flickering removals at the end.

## Why This Is Harder Than Code

You might be thinking: Claude does this with code all the time. Why is rich text different?

Code is flat text with line numbers. When an LLM edits code, it outputs lines. The editor diffs lines. Structure (functions, classes) is inferred from syntax but not validated during the edit.

Rich text editors like ProseMirror validate structure on every mutation. You can't insert a list item outside a list. You can't have text without a wrapping paragraph. Every operation must be a valid transformation of the current tree.

That's why you can't treat it like flat text. The tree structure is load-bearing.

## The Key Insight

Once Liveblocks gave the LLM a strict language and compared outputs themselves, everything clicked. The LLM wasn't failing because it's stupid; it was failing because they were asking it to do the wrong job.

Rewriting is generative. Diffing is analytical. LLMs are generative models. They're optimized for producing plausible next tokens, not for computing precise transformations of data structures.

When you need a transformation, compute it yourself. Let the LLM do what it's good at: generating valid output in a constrained space.

## The Trade-Off

This approach has a cost: token usage. You're sending the full document to the LLM and getting the full document back. For a 10-paragraph article, that might be 2000 tokens in and 2500 out.

Compare that to asking for a diff: "just tell me what changed" might be 1000 tokens in and 200 out.

But here's the thing: the diff approach doesn't work. Tokens are cheap. Broken documents are expensive.

If you're hitting token limits, chunk the document. Apply edits to one section at a time. The diffing approach still works because you're comparing two valid trees, even if they're subtrees.

## The Golden Rule

When integrating LLMs with structured editors: let the model rewrite in a constrained format, then compute the transformation yourself. Generation is what LLMs do best. Precision is what algorithms do best.

Don't ask a generative model to do analytical work.
