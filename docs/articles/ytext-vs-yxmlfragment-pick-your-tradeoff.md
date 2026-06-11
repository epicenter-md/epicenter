# Y.Text vs Y.XmlFragment: Pick Your Tradeoff

**TL;DR**: Neither Y.Text nor Y.XmlFragment is "correct" for collaborative markdown editing. The choice depends on who writes to your CRDT: humans through ProseMirror only, or external agents too.

> The core question isn't which backing type is better. It's who your writers are.

## The Fork in the Road

I spent weeks analyzing Y.Text and Y.XmlFragment for backing a collaborative markdown editor. I kept looking for the objectively correct answer. There isn't one.

The decision comes down to a single question: who writes to your CRDT?

If only ProseMirror writes to it, pure browser-to-browser collaboration, Y.XmlFragment with y-prosemirror is the obvious choice. You get native bindings, cursor tracking, presence, undo/redo, and tree-level formatting merges for free. Why would you build a custom binding?

But if external writers also need to write, agents or file system watchers or CLI tools or formatters, Y.XmlFragment becomes a liability. These writers produce strings, not trees. The only path from string to XmlFragment is clear-and-rebuild, which destroys CRDT identity and loses all concurrent edits. Y.Text with character-level diffing gives external writers a clean path to participate in the CRDT without nuking everyone else's changes.

## The Scenario

You have a markdown document in a CRDT. A human is editing it in ProseMirror in their browser. At the same time, an AI agent is editing the same document on the server. Both writers think they're making independent changes. What survives?

```
Human editor (ProseMirror):        Agent writer (produces string):
"Fix typo in intro"                "Add conclusion section"
   |                                   |
   v                                   v
Y.XmlFragment                       String output
```

With Y.XmlFragment + clear-and-rebuild, the agent's write destroys CRDT identity. The human's concurrent edit is lost. With Y.Text + diffChars, both edits preserve character-level CRDT identity. Non-overlapping changes both survive.

## The Full Comparison

| Concern | Y.Text + diffChars | Y.XmlFragment + clear-rebuild | Y.XmlFragment + updateYFragment |
|---|---|---|---|
| Agent write CRDT identity | ✅ character-level preserved | ❌ destroyed | ⚠️ paragraph-level |
| Concurrent edit safety | ✅ non-overlapping survives | ❌ all lost | ⚠️ paragraph matching can be wrong |
| Overlapping format safety | ⚠️ markers can interleave | ✅ tree-level marks merge | ✅ same |
| Revision history diffs | ✅ character-level diffs | ⚠️ coarse diffs (rollback still works via snapshots) | ⚠️ paragraph-level |
| Storage efficiency | ✅ proportional to changes | ❌ full tombstones every write | ⚠️ better |
| Cursor/presence | ⚠️ custom mapping needed | ✅ native y-prosemirror | ✅ same |
| Undo/redo | ⚠️ captureTimeout tuning | ✅ native yUndoPlugin | ✅ same |
| Code paths | 1 (unified) | 2 (dual-key branching) | 2 (dual-key branching) |
| Parse/serialize cost | Every keystroke + remote change | Only on agent read/write | Only on agent write |
| Custom code needed | Binding + cursor mapping | Nothing | Swap one function |

Let's walk through what each column means in practice.

## Y.Text + diffChars: One Path, Custom Binding

```typescript
// Agent writes directly to Y.Text
const newContent = await agent.generate(doc.toString());
diffChars(ytext, newContent);

// ProseMirror also writes to Y.Text through custom binding
const binding = new YTextBinding(ytext, prosemirrorView);
```

You have one code path. Both ProseMirror and external writers use Y.Text. Character-level CRDT identity is preserved for all writers. Concurrent non-overlapping edits survive.

The cost: you need to build a custom ProseMirror binding. y-prosemirror expects Y.XmlFragment, not Y.Text. You need to map ProseMirror positions (boundary-counting) to Y.Text positions (character-counting). You need to handle cursor tracking and undo yourself.

Parse and serialize happen constantly: every keystroke in ProseMirror and every remote change requires converting between string and ProseMirror doc.

When markdown syntax markers overlap (bold inside italic), you're working at the character level. Markers are just characters. If two writers format overlapping ranges differently, markers can interleave in ways that break syntax.

Revision history is character-granular. You can show exactly which characters changed between versions.

## Y.XmlFragment + Clear-Rebuild: Zero Custom Code

```typescript
// Agent writes by destroying everything
yxmlfragment.delete(0, yxmlfragment.length);
const newDoc = markdownParser.parse(agentOutput);
prosemirrorToYXmlFragment(newDoc, yxmlfragment);

// ProseMirror uses y-prosemirror
const binding = new ProseMirrorBinding(yxmlfragment, prosemirrorView);
```

You write zero custom code. y-prosemirror handles everything: syncing ProseMirror to Y.XmlFragment, cursor tracking, presence, undo/redo.

Tree-level formatting merges correctly. If two writers apply bold and italic to overlapping ranges, the tree structure ensures marks compose cleanly.

The cost: agent writes destroy CRDT identity. The clear-and-rebuild pattern deletes everything and inserts everything. Yjs sees every character as deleted and re-inserted. All concurrent human edits are lost.

Revision history diffs show "everything changed" for every agent write. You can't see granular diffs between versions. However, snapshots with `gc: false` still capture complete document state. Rollback and version browsing work perfectly; only the diff granularity is coarse.

Storage is inefficient. Every agent write creates tombstones for every character, even if only one line changed.

You have two code paths: Y.XmlFragment for richtext, something else for plain code files. The dual-key branching adds complexity.

## Y.XmlFragment + updateYFragment: The Middle Ground

```typescript
// Agent writes with paragraph-level diffing
const newDoc = markdownParser.parse(agentOutput);
updateYFragment(yxmlfragment, newDoc);

// ProseMirror still uses y-prosemirror
const binding = new ProseMirrorBinding(yxmlfragment, prosemirrorView);
```

You swap one function. Instead of clear-and-rebuild, you use updateYFragment, which diffs at the paragraph level.

CRDT identity is preserved at paragraph granularity. If a human edits paragraph 2 and an agent edits paragraph 5, both changes survive.

The cost: paragraph matching can be wrong. updateYFragment matches paragraphs by heuristics (first sentence similarity). If the agent rewrites a paragraph heavily, the heuristic might match it to the wrong existing paragraph or treat it as new. Concurrent edits to that paragraph might be applied to the wrong target.

Revision history is paragraph-granular. Better than "everything changed", but you can't see character-level diffs within a paragraph.

You still have dual-key branching. Y.XmlFragment for richtext, Y.Text for code files.

## The Decision Tree

```
Do external agents write to the CRDT?
│
├─ No: Pure human collaboration
│  └─> Y.XmlFragment + y-prosemirror
│      (Native binding, cursor/presence/undo for free)
│
└─ Yes: Agents are concurrent writers
   │
   ├─ Are agents the primary writer?
   │  └─> Y.Text + diffChars
   │      (One code path, character-level identity, custom binding)
   │
   └─ Are agent writes rare?
       └─> Y.XmlFragment + updateYFragment
           (Paragraph-level identity, minimal code change)
```

## When Y.Text Wins

You should choose Y.Text if:

- Agents are your primary concurrent writer, not humans.
- You want one unified code path for all file types (markdown and plain code).
- Revision history quality matters. Character-level diffs are non-negotiable.
- Storage efficiency matters. You can't afford full tombstones on every agent write.
- You're willing to build a custom ProseMirror binding and handle cursor mapping.

This is the path we're taking for Epicenter. Agents write frequently. We need one code path for markdown and code files. We need granular revision history. The custom binding cost is acceptable.

## When Y.XmlFragment Wins

You should choose Y.XmlFragment if:

- Pure human-to-human collaboration is your only use case.
- You need correct overlapping format merging at the tree level.
- You want y-prosemirror's cursor/presence/undo for free.
- External agent writes are rare or can accept clear-and-rebuild.

This is the right choice for most collaborative markdown editors. Notion, Dropbox Paper, Google Docs-style apps. Humans are the writers. Tree-level formatting is valuable. No reason to reinvent y-prosemirror.

## The Honest Middle Ground

Start with Y.XmlFragment + updateYFragment. Swap one function, get immediate improvement over clear-and-rebuild. Paragraph-level CRDT identity is better than nothing. You keep y-prosemirror's cursor and undo.

If paragraph-level revision history isn't granular enough, or the dual-key complexity becomes a maintenance burden, or you need better concurrent edit safety, migrate to Y.Text. You'll know when the tradeoff tips.

## The Golden Rule

**Design your CRDT backing type for your writers, not your readers.** Readers can adapt to any backing type. Writers need a path that preserves CRDT identity.

## Related

- [Diff-Based Sync Guesses Intent, CRDT Operations Express It](./diff-reconciliation-is-not-a-crdt-operation.md)
- [Nobody Built ProseMirror on Y.Text Because Nobody Needed To](./why-nobody-built-prosemirror-on-ytext.md)
- [Full Doc Replacement Is a UI Problem, Not a Data Problem](./full-doc-replacement-is-a-ui-problem-not-a-data-problem.md)
- [Clear-and-Rebuild Is the Real CRDT Violation](./clear-and-rebuild-is-the-real-crdt-violation.md)
- [Character Diffs Shrink the Blast Radius of Conflicts](./blast-radius-of-conflict-character-diff-vs-document-replace.md)
- [Markdown Formatting Markers Collide Because CRDTs Don't See Pairs](./markdown-syntax-markers-share-the-character-stream.md)
- [CRDTs Stop Concurrent Writes, But Not Your Agent's Stale Read](./the-read-modify-write-race-in-crdts.md)
- [Parser Fidelity Is Your Single Point of Failure](./parser-fidelity-is-your-single-point-of-failure.md)
- [Markdown Normalization Converges in One Pass](./markdown-normalization-converges-in-one-pass.md)
- [ProseMirror Positions Count Boundaries, Not Characters](./prosemirror-positions-count-boundaries-not-characters.md)
