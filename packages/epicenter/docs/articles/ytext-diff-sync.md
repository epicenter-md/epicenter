# Syncing Y.Text with Diff-Based Updates

I needed a way to sync a Y.Text object to match a new string value without losing the collaborative editing benefits of CRDTs.

## The Problem

When you have a Y.Text and want to update it to match a new string, the naive approach is to delete everything and insert the new content:

```typescript
ytext.delete(0, ytext.length);
ytext.insert(0, newString);
```

This works, but it destroys the CRDT character identity. Every character becomes "new" from the perspective of the conflict-free replicated data type, which can cause issues in collaborative editing scenarios.

## The Solution

`updateYTextFromString` computes the minimal character-level differences between the current Y.Text content and the target string, then applies only the necessary insertions and deletions:

```typescript
import { updateYTextFromString } from '@epicenter/hq';

const ytext = ydoc.getText('content');
ytext.insert(0, 'Hello World');

updateYTextFromString(ytext, 'Hello Beautiful World');
// Y.Text now contains "Hello Beautiful World"
// Only "Beautiful " was inserted; "Hello " and "World" were preserved
```

## How It Works

The function uses the `diff` library to compute character-level differences, then walks through the diff operations sequentially:

1. **EQUAL**: Characters match, advance position
2. **DELETE**: Remove characters at current position, don't advance (content shifts left)
3. **INSERT**: Add new characters at current position, advance by inserted length

This preserves character identity wherever possible, which matters for CRDT semantics and operational transformation in collaborative editing.

## Primary Use Case: File System Sync

The main use case is syncing file system changes to Y.Text. When you have markdown files or other text files bound to Y.Text objects, external edits to those files need to be synced back to the CRDT:

```typescript
import { watch } from 'chokidar';
import { readFile } from 'fs/promises';

// Watch a markdown file
const watcher = watch('notes.md');

watcher.on('change', async (path) => {
	// Read the updated file content
	const newContent = await readFile(path, 'utf-8');

	// Get the Y.Text bound to this file
	const ytext = ydoc.getText('notes');

	// Sync with minimal diff operations
	updateYTextFromString(ytext, newContent);

	// Now the Y.Text matches the file, and changes propagate
	// to other collaborators with proper CRDT semantics
});
```

This pattern works for any scenario where you're mirroring file system content into Y.Text documents. The diff-based approach means that when someone edits `notes.md` in their text editor, only the actual changes get transmitted to collaborators, not the entire file content.

## Other Use Cases

**Syncing form inputs to Y.Text**: When a user types in a controlled input and you want to sync their changes to a Y.Text without breaking collaborative editing.

**Applying external edits**: When you need to apply changes from a non-collaborative source (like a formatter or linter) to a collaborative Y.Text document.

**State reconciliation**: When synchronizing Y.Text state with external systems that provide the full target string rather than incremental changes.

## What It Doesn't Do

This function doesn't handle Y.Text formatting attributes. It only syncs the plain text content. If you need to preserve or sync formatting, you'll need additional logic.
