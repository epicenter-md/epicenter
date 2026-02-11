---
name: method-shorthand-jsdoc
description: Move helper functions into return objects using method shorthand for proper JSDoc preservation. Use when factory functions have internal helpers that should expose documentation to consumers, or when hovering over returned methods shows no JSDoc.
metadata:
  author: epicenter
  version: '1.0'
---

# Method Shorthand for JSDoc Preservation

When factory functions have helper functions that are only used by returned methods, move them INTO the return object using method shorthand. This ensures JSDoc comments are properly passed through to consumers.

## The Problem

You write a factory function with a well-documented helper:

```typescript
function createHeadDoc(options: { workspaceId: string }) {
	const { workspaceId } = options;

	/**
	 * Get the current epoch number.
	 *
	 * Computes the maximum of all client-proposed epochs.
	 * This ensures concurrent bumps converge to the same version.
	 *
	 * @returns The current epoch (0 if no bumps have occurred)
	 */
	function getEpoch(): number {
		let max = 0;
		for (const value of epochsMap.values()) {
			max = Math.max(max, value);
		}
		return max;
	}

	return {
		workspaceId,
		getEpoch, // JSDoc is NOT visible when hovering on returned object!

		bumpEpoch(): number {
			const next = getEpoch() + 1; // Calling internal helper
			return next;
		},
	};
}
```

When you hover over `head.getEpoch()` in your IDE, you see... nothing. The JSDoc is lost.

## The Solution

Move the helper INTO the return object using method shorthand:

```typescript
function createHeadDoc(options: { workspaceId: string }) {
	const { workspaceId } = options;

	return {
		workspaceId,

		/**
		 * Get the current epoch number.
		 *
		 * Computes the maximum of all client-proposed epochs.
		 * This ensures concurrent bumps converge to the same version.
		 *
		 * @returns The current epoch (0 if no bumps have occurred)
		 */
		getEpoch(): number {
			let max = 0;
			for (const value of epochsMap.values()) {
				max = Math.max(max, value);
			}
			return max;
		},

		bumpEpoch(): number {
			const next = this.getEpoch() + 1; // Use this.methodName()
			return next;
		},
	};
}
```

Now hovering over `head.getEpoch()` shows the full JSDoc.

## Why This Works

1. **JSDoc attaches to the method definition site** - when methods are inline in the return object, the JSDoc is directly on the property TypeScript sees
2. **Method shorthand uses `function` semantics** - `this` is bound to the object, so `this.getEpoch()` works
3. **No separate helper needed** - if it's only used by sibling methods, it belongs in the same object

## The Pattern

```typescript
// BAD: Helper defined separately, JSDoc lost on return
function createService(client) {
  /** Fetches user data with caching. */
  function fetchUser(id: string) { ... }

  return {
    fetchUser,  // JSDoc not visible to consumers!
    getProfile(id: string) {
      return fetchUser(id);  // Works, but consumers can't see docs
    },
  };
}

// GOOD: Method shorthand, JSDoc preserved
function createService(client) {
  return {
    /** Fetches user data with caching. */
    fetchUser(id: string) { ... },

    getProfile(id: string) {
      return this.fetchUser(id);  // Use this.method()
    },
  };
}
```

## When to Apply

Use this pattern when:

- Helper functions are ONLY used by methods in the return object
- You want JSDoc visible when consumers hover over the method
- The helper doesn't need to be called before the return statement

Keep helpers separate when:

- They're called during initialization (before return)
- They're used by multiple factories (extract to shared module)
- They're truly internal and shouldn't be exposed

## Arrow Functions Don't Work

Arrow functions don't have their own `this`:

```typescript
// BAD: Arrow function, this is undefined
return {
  getEpoch: () => { ... },
  bumpEpoch: () => {
    this.getEpoch();  // ERROR: this is undefined!
  },
};

// GOOD: Method shorthand has correct this binding
return {
  getEpoch() { ... },
  bumpEpoch() {
    this.getEpoch();  // Works!
  },
};
```

## Real Example

From `packages/epicenter/src/core/docs/head-doc.ts`:

```typescript
export function createHeadDoc(options: { workspaceId: string; ydoc?: Y.Doc }) {
	const { workspaceId } = options;
	const ydoc = options.ydoc ?? new Y.Doc({ guid: workspaceId });
	const epochsMap = ydoc.getMap<number>('epochs');

	return {
		ydoc,
		workspaceId,

		/**
		 * Get the current epoch number.
		 *
		 * Computes the maximum of all client-proposed epochs.
		 * This ensures concurrent bumps converge to the same version
		 * without skipping epoch numbers.
		 *
		 * @returns The current epoch (0 if no bumps have occurred)
		 */
		getEpoch(): number {
			let max = 0;
			for (const value of epochsMap.values()) {
				max = Math.max(max, value);
			}
			return max;
		},

		/**
		 * Bump the epoch to the next version.
		 *
		 * @returns The new epoch number after bumping
		 */
		bumpEpoch(): number {
			const next = this.getEpoch() + 1;
			epochsMap.set(ydoc.clientID.toString(), next);
			return next;
		},

		// ... other methods using this.getEpoch()
	};
}
```

## Summary

| Approach                    | JSDoc Visible? | `this` Works? |
| --------------------------- | -------------- | ------------- |
| Separate helper + reference | No             | N/A           |
| Arrow function in return    | Yes            | No            |
| Method shorthand in return  | Yes            | Yes           |

Method shorthand is the only approach that preserves JSDoc AND allows methods to call each other via `this`.

## References

- [docs/articles/method-shorthand-jsdoc-preservation.md](../../docs/articles/method-shorthand-jsdoc-preservation.md) - Same content as article
