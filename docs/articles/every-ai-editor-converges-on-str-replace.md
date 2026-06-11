# Every AI Editor Converges on str_replace

**TL;DR: Every production AI editing system: Cursor, Aider, Claude Code, OpenAI Codex, Tiptap AI: has independently arrived at the same edit format: text-level search/replace anchored by surrounding context. Nobody has the AI output tree operations, ProseMirror transactions, or structured CRDT operations. This isn't a coincidence. It's the only thing that works.**

> If you're building an AI-editable system, optimize your storage for text read/write. The entire industry already told you the answer.

## The convergence

Look at how every major AI coding tool represents edits:

| System | Edit format |
|---|---|
| Cursor | Semantic diff with `// ... existing code ...` |
| Aider | `<<<<<<< SEARCH` / `>>>>>>> REPLACE` blocks |
| Claude Code | `str_replace(old_string, new_string)` |
| OpenAI Codex | `*** Begin Patch` with context markers |
| Tiptap AI Toolkit | `{type: 'jump', context}` + `{type: 'replace', delete, insert}` |

Five independent teams. Five different products. The same pattern: find a chunk of text by matching its content, replace it with new content. The surrounding text is the anchor, not a line number, not a tree path, not a node ID.

Nobody asked these teams to coordinate. They tried other approaches first. They all ended up here.

## What nobody does

No production system has the AI output:

- **ProseMirror transactions**: steps with positions, marks, and node types
- **Yjs CRDT operations**: insert/delete at document-internal positions
- **AST transformations**: "wrap the third child of the function body in a try/catch"
- **JSON tree diffs**: "replace node at path `/body/children/2/text`"
- **RFC 6902 JSON Patch**: `[{op: "replace", path: "/foo/1/bar", value: "baz"}]`

It's not that people haven't tried. It's that LLMs can't reliably produce these formats. They lose track of array indices. They miscalculate positions. They drop structural context when documents get long.

## The closest anyone got

The closest thing to structured AI edits is JSON Whisperer (EMNLP 2025). Researchers got LLMs to output RFC 6902 JSON patches. But only after a critical trick: they replaced array indices with stable two-character keys using something called EASE encoding.

Standard JSON Patch asks the LLM to reason about array positions:

```json
[
  {"op": "remove", "path": "/items/3"},
  {"op": "add", "path": "/items/2", "value": {"name": "new"}}
]
```

Remove index 3, then add at index 2. But wait, removing index 3 shifted everything, so index 2 is now pointing somewhere different. This kind of index arithmetic is exactly what LLMs are bad at.

EASE encoding sidesteps it by giving every array element a stable two-character ID:

```json
[
  {"op": "remove", "path": "/items/Bc"},
  {"op": "add", "path": "/items/Bc", "value": {"name": "new"}}
]
```

No arithmetic. The IDs don't shift. This works, but only for JSON. Rich document trees are harder: deeper nesting, more node types, interleaved text and structure. And even with EASE encoding, you're fighting the model's natural tendency to produce text, not data structures.

## Why this happens

Transformers are autoregressive sequence models. They predict the next token based on all previous tokens. This makes them exceptional at one thing: producing text that looks like text they've seen before.

Search/replace is text that looks like text. The "search" part is literally a copy of the existing code. The "replace" part is the new code. The model is just producing text. The same thing it does for every other task.

Tree operations are fundamentally different. "Insert node X as the third child of the blockquote that's inside the second list item" requires:

1. Parsing the current tree structure from context
2. Navigating to the right position
3. Counting children correctly
4. Outputting a precisely formatted operation
5. Keeping all of this consistent with concurrent changes

Steps 2-4 are index arithmetic in disguise. The model has to maintain a mental model of a tree while generating tokens left to right. It's like asking someone to edit a file by specifying byte offsets: technically possible, practically unreliable.

## What this means if you're building something

If your system will be edited by AI agents, your storage format should optimize for text operations:

1. **`readFile()` should return plain text**: markdown or code, directly. Not a JSON AST. Not a serialized CRDT state. Text.
2. **`writeFile()` should apply text diffs**: take the agent's text output, diff it against current content, apply character-level operations that compose with concurrent edits.
3. **Rich editing is a view on the text, not the source of truth**: your WYSIWYG editor renders from the text. It doesn't own the canonical format.

This doesn't mean you can't have rich editing. It means the rich editor and the AI agent both operate on the same underlying text representation, and the editor interprets structure from it.

## The takeaway

The industry already ran the experiment. Billions of dollars of AI coding tools, built by the best engineering teams, all converged on the same answer: text search/replace with context anchoring.

If you're designing a storage format, a CRDT schema, or a file system that AI agents will touch: stop trying to get the model to output structured operations. Give it text. Let it edit text. Handle the structure yourself.
