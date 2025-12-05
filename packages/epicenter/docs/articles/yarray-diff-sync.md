# Syncing Y.Array with Diff-Based Updates

I needed a way to sync a Y.Array to match a new array value without losing the collaborative editing benefits of CRDTs.

## The Problem

When you have a Y.Array and want to update it to match a new array, the naive approach is to clear everything and insert the new content:

```typescript
yarray.delete(0, yarray.length);
yarray.insert(0, newArray);
```

This works, but it destroys the CRDT element identity. Every element becomes "new" from the perspective of the conflict-free replicated data type, which can cause issues in collaborative editing scenarios.

## The Solution

`updateYArrayFromArray` computes the minimal element-level differences between the current Y.Array content and the target array, then applies only the necessary insertions and deletions:

```typescript
import { updateYArrayFromArray } from '@epicenter/hq';

const yarray = ydoc.getArray('tags');
yarray.push(['typescript', 'javascript']);

updateYArrayFromArray(yarray, ['typescript', 'svelte', 'javascript']);
// Y.Array now contains ['typescript', 'svelte', 'javascript']
// Only 'svelte' was inserted; 'typescript' and 'javascript' were preserved
```

## How It Works

The function uses a simple diff algorithm that compares arrays element by element:

1. If elements match at the current position, advance both pointers
2. If an element was removed, delete it from Y.Array
3. If an element was added, insert it into Y.Array
4. If elements don't match, look ahead to see if the current element exists later in the new array

This preserves element identity wherever possible. For simple insertions and deletions, it produces the minimal diff. For complex reorderings, it may not be absolutely minimal, but it always converges to the correct final state.

## Primary Use Case: Tags Fields

The main use case is syncing tags field values. In Epicenter, tags columns use Y.Array to store their values. When you need to sync these from external sources (like file system metadata or API responses), you want minimal operations:

```typescript
// In your workspace schema
const schema = {
	posts: {
		id: id(),
		title: text(),
		tags: tags({
			options: ['typescript', 'javascript', 'svelte', 'rust'],
		}),
	},
};

// Reading post metadata from file system
const frontmatter = parseMarkdownFrontmatter('post.md');
// frontmatter.tags = ['typescript', 'svelte']

// Get the Y.Array for this post's tags
const post = db.tables.posts.get(postId);
const tagsArray = post.row.tags; // This is a Y.Array<string>

// Sync with minimal diff operations
updateYArrayFromArray(tagsArray, frontmatter.tags);

// Now the Y.Array matches the file metadata, and changes
// propagate to other collaborators with proper CRDT semantics
```

This pattern works for any scenario where you're mirroring array data from external sources into Y.Array fields. The diff-based approach means only the actual changes get transmitted to collaborators.

## Other Use Cases

**Form tags inputs**: When syncing user selections from a UI component to a Y.Array without destroying collaborative state.

**Tag management**: When syncing tags or categories from external systems to collaborative documents.

**List synchronization**: When mirroring any list-like data structure into Y.Array while preserving CRDT semantics.

## Limitations

The algorithm compares elements using strict equality (`===`). For complex objects, you may need to implement custom comparison logic or use a different approach.

Reorderings are handled but may not produce the absolute minimal diff. The algorithm treats reordering as a series of deletions and insertions.
