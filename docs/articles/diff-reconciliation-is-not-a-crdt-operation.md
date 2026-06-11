# Diff-Based Sync Guesses Intent, CRDT Operations Express It

**TL;DR**: Diffing a string to sync Yjs doesn't express intent. It guesses what you meant based on before/after states.

> When you call `yText.insert(6, "Beautiful ")`, you're saying "insert 'Beautiful' here". When you call `updateYTextFromString(yText, "Hello Beautiful World")`, you're saying "make it look like this" and letting the diff algorithm guess what operations will get you there.

## The Code

Here's a typical diff-based sync function:

```typescript
export function updateYTextFromString(yText: Y.Text, newString: string): void {
  const doc = yText.doc;
  if (!doc) throw new Error('Y.Text must be attached to a Y.Doc');

  const currentString = yText.toString();
  if (currentString === newString) return;

  const diffs = diffChars(currentString, newString);

  doc.transact(() => {
    let index = 0;
    for (const change of diffs) {
      if (change.added) {
        yText.insert(index, change.value);
        index += change.value.length;
      } else if (change.removed) {
        yText.delete(index, change.value.length);
      } else {
        index += change.value.length;
      }
    }
  });
}
```

This is not a CRDT operation. It's a best-effort conversion from desired state to operations.

## The Difference

```typescript
// CRDT operation: intent is unambiguous
yText.insert(6, "Beautiful ");

// Diff-based: intent is inferred from before/after
updateYTextFromString(yText, "Hello Beautiful World");
```

The first one says exactly what to do. The second one says "figure out what operations turn current state into this state."

## When the Guess Goes Wrong

You're building an AI agent that edits documents. Here's what happens:

```
t=0s   Agent reads: "Hello World"
       Agent starts thinking about edits

t=15s  User changes "World" to "Earth"
       Current state: "Hello Earth"

t=30s  Agent finishes thinking, calls:
       updateYTextFromString(yText, "Hello Beautiful World")
```

What does the function do?

```
Current:  "Hello Earth"
Desired:  "Hello Beautiful World"

Diff:
  keep "Hello "
  delete "Earth"              ← user's edit, gone
  insert "Beautiful World"
```

The user's change to "Earth" is deleted. The diff algorithm sees "Earth" as something to remove because it's not in the desired output.

## The Flow Chart

```
CRDT Operation:
  Intent → Operation → State

Diff-Based Sync:
  Old State + New State → Diff → Guess Intent → Operations → State
```

One expresses intent directly. The other reconstructs intent from observed state changes.

## Why Use It Anyway?

Because the alternative is worse:

| Approach           | Overlapping Edits | Non-Overlapping Edits | Single Writer |
| ------------------ | ----------------- | --------------------- | ------------- |
| Clear and rebuild  | Lost              | Lost                  | Works         |
| Diff-based sync    | Lost              | Preserved             | Works         |
| CRDT operations    | Merged            | Merged                | Works         |

If your agent reads "Hello World" and writes "Hello Beautiful Galaxy", and the user changed "World" to "Earth" in between, diff-based sync gives you "Hello Beautiful Galaxy". The "Earth" edit is gone, but only because it overlaps with the agent's change.

If the user changed something else. Say, added a title above the text. That survives. Clear-and-rebuild would nuke everything.

## When It's Correct

The guess is right when:

1. No concurrent edits happened (single writer at a time)
2. Concurrent edits don't overlap with changed regions
3. You're syncing from an external source that doesn't speak CRDT operations

The common case is correct. You only see problems when edits collide.

## What This Means for Agents

If you're building an AI that edits Yjs documents:

- Use CRDT operations when you can compute them directly
- Use diff-based sync when you're adapting an external tool (like an LLM that outputs full text)
- Understand that diff-based sync trades precision for convenience

The function is a tool for bridging systems. It's not wrong, it's just doing a different job than a CRDT operation.

## Related

- [The Read-Modify-Write Race in CRDTs](./the-read-modify-write-race-in-crdts.md): The upstream problem that makes diffs guess wrong
- [The Blast Radius of Conflict](./blast-radius-of-conflict-character-diff-vs-document-replace.md): Why diffs are still worth it despite the guessing
- [Clear-and-Rebuild Is the Real CRDT Violation](./clear-and-rebuild-is-the-real-crdt-violation.md): The alternative is worse
- [Y.Text vs Y.XmlFragment: Pick Your Tradeoff](./ytext-vs-yxmlfragment-pick-your-tradeoff.md): The full comparison
