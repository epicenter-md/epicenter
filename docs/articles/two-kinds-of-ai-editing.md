# Two Kinds of AI Editing

**TL;DR: There are two fundamentally different AI editing contexts, the interactive copilot and the external agent, and most people conflate them. The copilot operates on a frozen snapshot with human-gated merges. The agent operates on a live document with concurrent edits. They need different solutions.**

> The copilot can use flatten-diff against a schema. The agent needs text-level composability with concurrent edits. Mixing them up leads to architectures that solve neither problem well.

## The two contexts

When people say "AI editing," they mean one of two things and usually don't realize it.

### Context 1: Interactive copilot

The user highlights text in a rich editor. They type "make this more concise" or "add error handling." The AI rewrites the selection. The changes appear in a suggestion layer. The user accepts or rejects.

This is what Notion AI, Tiptap AI, and every "AI writing assistant" does. The workflow:

1. User highlights a region
2. System snapshots the current document state
3. AI receives the snapshot and produces a rewrite
4. System diffs the rewrite against the snapshot
5. Changes go into a preview/suggestion layer
6. User accepts, rejects, or edits the suggestion

The critical property: **the AI operates on a frozen snapshot.** While the AI is thinking, the document doesn't change from the AI's perspective. And the human gates the merge, nothing lands without explicit approval.

This means concurrent edits aren't really a problem. If another user edits a different part of the document while the AI is working, those edits exist in the live document but not in the AI's snapshot. When the user accepts the suggestion, the system merges the AI's changes into the current state. Since the AI only touched the highlighted region, conflicts are rare and human-resolvable.

### Context 2: External agent writeFile()

A coding agent: Claude Code, Cursor's agent mode, Aider: reads a file from the filesystem, reasons about it for seconds to minutes, then writes back a modified version. The agent has no awareness of the editor. It doesn't know about your ProseMirror schema or your CRDT state. It read text. It writes text.

The workflow:

1. Agent calls `readFile('/src/api.ts')` and gets back a string
2. Agent reasons about the code (possibly making multiple tool calls)
3. Agent calls `writeFile('/src/api.ts', newContent)` or `str_replace(old, new)`
4. System applies the change

The critical property: **the document is live.** While the agent is thinking, other users (or other agents) might be editing the same file. There's no snapshot isolation. There's no human gating the merge. The system has to handle concurrent edits automatically.

## Why they need different solutions

| | Interactive copilot | External agent |
|---|---|---|
| **Input format** | Constrained markup matching editor schema | Raw text (markdown, code) |
| **Output format** | Constrained markup or clean rewrite | Raw text or text diff |
| **Concurrency** | Snapshot isolation + human merge gate | Live document, concurrent edits |
| **Diff strategy** | Flatten-diff (Liveblocks approach) | Text diff → character ops |
| **Conflict handling** | User reviews and resolves | Must compose automatically |
| **Latency** | Sub-second to seconds | Seconds to minutes |

### The copilot can use flatten-diff

Since the copilot operates on a snapshot and produces schema-constrained output, you can use the [Liveblocks flatten-diff pattern](./liveblocks-flatten-diff-pattern.md):

1. Constrain the AI's output to a restricted markup format matching your editor schema
2. Ask for a complete rewrite, not a diff (LLMs are good at rewriting)
3. Flatten both old and new documents into token sequences with structural metadata
4. Run LCS text-diff on the flattened form
5. Reconstruct a structured diff

This gives you a clean, node-level diff between the original and the AI's rewrite. You can show additions in green, deletions in red, updates in yellow. The user sees exactly what changed and decides what to keep.

It works because you control both sides: you constrain what the AI outputs, and you control when the merge happens.

### The agent needs text composability

The external agent doesn't know about your schema. It read a markdown file or a TypeScript file. It outputs markdown or TypeScript. Asking it to produce ProseMirror-compatible JSX is a non-starter.

More importantly, the agent's output needs to compose with concurrent edits. If User A is editing paragraph 3 while the agent rewrites paragraph 7, both changes should survive. This means:

1. Agent produces text (markdown, code)
2. System diffs agent output against current document text
3. Diff produces character-level insert/delete operations
4. Character ops compose naturally with concurrent CRDT operations

Text diffing handles this because character-level operations are the smallest unit of change. Insert "foo" at position 42 doesn't conflict with insert "bar" at position 200. CRDTs handle this natively.

### Where flatten-diff breaks for agents

You might think: just use flatten-diff for everything. Parse the agent's markdown into a tree, diff the trees. Three problems:

**1. Parsing is lossy.** Your editor might have custom nodes: callouts, code blocks with metadata, embedded widgets. The agent's markdown doesn't know about these. Parsing the agent's output back into your schema loses them or maps them incorrectly.

**2. Tree-to-tree matching is fragile.** Two independently-parsed trees can represent the same text with different structures. A paragraph followed by a list might be one node or two depending on whitespace. Matching nodes between two trees that were built independently is an unsolved problem.

**3. The concurrent deletion problem.** If the agent reads a file, thinks for two minutes, and writes back a version that doesn't include a paragraph User B added during those two minutes, the tree diff sees a deletion. The new paragraph disappears. With text diffing, the agent's changes are localized to the characters it actually modified, and User B's paragraph survives because the agent never touched those character positions.

## The takeaway

When someone says "AI editing," ask which kind. The interactive copilot and the external agent look similar from a distance. Up close, they have opposite constraints: one gets snapshot isolation and human-gated merges, the other gets concurrent edits and no human in the loop.

Build for both, but don't pretend one solution covers both cases. The copilot gets flatten-diff and structured suggestions. The agent gets text in, text out, character ops that compose with the CRDT.
