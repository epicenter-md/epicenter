# Type Composition Across Platform-Specific Files

When you have two type shapes that overlap, there are three operations for composing them without duplication. The choice depends on two factors: the relationship between the types (superset vs partial overlap) and whether you can import between the files (runtime boundaries).

**The three operations:**

1. **Direct intersection** - Import the subset, compose via `&`
2. **Extract subset to shared** - When runtime boundaries prevent direct import
3. **Extract overlap to shared** - When neither type is a strict superset

Different runtimes (Node.js vs browser) complicate imports. Even if browser types are a superset of Node.js types, you can't import a Node.js file into a browser build. This forces extraction to a shared file even when the type relationship would otherwise allow direct import.

## Three Scenarios

### Scenario 1: Direct Intersection (Same Runtime)

When one type is a strict superset of another and they run in the same environment, just import and intersect. The key insight: the base type isn't a "shared" extraction. It's a complete, standalone type that another type happens to extend.

```typescript
// browser-options.ts - This is a complete type, not a "shared" file
export type BrowserClientOptions = {
	timeout: number;
	retries: number;
};

// node-options.ts - Node has everything browser has, plus filesystem options
import type { BrowserClientOptions } from './browser-options';

export type NodeClientOptions = BrowserClientOptions & {
	projectDir: string; // Only makes sense in Node (filesystem access)
};
```

This is common in libraries with multiple runtimes: browser and Node implementations are similar, but Node accepts extra arguments that don't make sense in the browser.

### Scenario 2: Extract Overlap to Shared

When two types share properties but neither is a strict superset:

```typescript
// Type A: { id, name, browserOnly }
// Type B: { id, name, nodeOnly }
// Shared:  { id, name }
```

Extract the intersection to a third file:

```typescript
// shared.ts
export type CommonProps = {
	id: string;
	name: string;
};

// browser.ts
import type { CommonProps } from './shared';
export type BrowserConfig = CommonProps & { browserOnly: string };

// node.ts
import type { CommonProps } from './shared';
export type NodeConfig = CommonProps & { nodeOnly: string };
```

### Scenario 3: Extract Subset to Shared (Runtime Boundaries)

Even when browser is a strict superset of Node.js types, you can't import Node.js runtime files into browser builds. Bundlers enforce platform boundaries.

```
browser.ts  --->  node.ts     // NOT ALLOWED (bundler will fail)
browser.ts  --->  shared.ts   // OK
node.ts     --->  shared.ts   // OK
```

The solution is always to move shared types to a platform-agnostic file:

```typescript
// client.shared.ts (no platform-specific imports)
export type WorkspaceClientInternals = {
	$ydoc: Y.Doc;
	$tables: Tables;
	destroy: () => Promise<void>;
};

// client.browser.ts
import type { WorkspaceClientInternals } from './client.shared';

export type WorkspaceClient<TActions> = TActions &
	WorkspaceClientInternals & {
		whenReady: Promise<void>; // Browser-specific
	};

// client.node.ts
import type { WorkspaceClientInternals } from './client.shared';

export type WorkspaceClient<TActions> = TActions & WorkspaceClientInternals;
// No whenReady - Node clients are fully initialized
```

## Real Example: Epicenter Workspace Clients

Before refactoring, both `client.browser.ts` and `client.node.ts` had ~60 lines of identical type definitions with JSDoc:

```typescript
// DUPLICATED in both files
export type WorkspaceClient<TActions> = TActions & {
	/** The underlying YJS document... */
	$ydoc: Y.Doc;
	/** Direct access to workspace tables... */
	$tables: Tables;
	/** Direct access to workspace providers... */
	$providers: Providers;
	/** Async cleanup method... */
	destroy: () => Promise<void>;
	[Symbol.asyncDispose]: () => Promise<void>;
	// Browser also had: whenReady: Promise<void>
};
```

After extracting to `client.shared.ts`:

```typescript
// client.shared.ts - JSDoc lives here once
export type WorkspaceClientInternals<TSchema, TProviders> = {
	/** The underlying YJS document... */
	$ydoc: Y.Doc;
	// ... all shared properties with full JSDoc
};

// client.browser.ts - just compose
export type WorkspaceClient<TActions, TSchema, TProviders> = TActions &
	WorkspaceClientInternals<TSchema, TProviders> & {
		whenReady: Promise<void>;
	};

// client.node.ts - even simpler
export type WorkspaceClient<TActions, TSchema, TProviders> = TActions &
	WorkspaceClientInternals<TSchema, TProviders>;
```

## Decision Flowchart

```
Is type A a superset of type B?
├─ Yes: Can A's file import from B's file? (same runtime)
│   ├─ Yes: Import B, compose A = B & { extras }
│   └─ No (different runtimes): Extract B to shared file
└─ No (partial overlap): Extract common props to shared file
```

## Key Takeaways

1. **JSDoc in one place**: Put documentation on the shared type; composed types inherit the meaning
2. **Bundler boundaries are real**: Even if types are compatible, platform imports must respect bundler conditions
3. **Shared files must be platform-agnostic**: No `node:*` imports, no browser APIs in shared files
4. **Intersection preserves structure**: `A & B` gives you all properties from both with full type safety
