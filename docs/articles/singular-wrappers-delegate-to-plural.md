# Implement the Singular Versions as Simple Wrappers That Delegate to Their Plural Counterparts

When an API has both singular and plural variants of the same operation, put all the logic in the plural version. The singular version normalizes its input into an array, calls the plural one, and does nothing else. One code path, one source of truth.

```typescript
// The plural version has ALL the logic
forProfiles(profiles: string[]) {
  this.scope = { type: 'include', profiles };
  return this.builder;
}

// The singular version is a one-liner
forProfile(profile: string) {
  return this.forProfiles([profile]);
}
```

This applies everywhere you have a "one or many" variant: method chains, standalone functions, builder APIs. The shape is always the same: singular wraps the input in an array, calls plural, returns whatever plural returns.

## Method Chains: `.forProfile()` Delegates to `.forProfiles()`

Consider a workspace builder where document extensions can be scoped to specific profiles. You need four postfix methods: `.forProfile()`, `.forProfiles()`, `.exceptProfile()`, `.exceptProfiles()`.

The plural versions carry the implementation:

```typescript
type ScopeModifiers = {
	forProfile(profile: string): Builder;
	forProfiles(profiles: string[]): Builder;
	exceptProfile(profile: string): Builder;
	exceptProfiles(profiles: string[]): Builder;
};

function createScopeModifiers(
	registration: ExtensionRegistration,
	builder: Builder,
): ScopeModifiers {
	return {
		forProfiles(profiles) {
			registration.scope = { type: 'include', profiles };
			return builder;
		},
		forProfile(profile) {
			return this.forProfiles([profile]);
		},

		exceptProfiles(profiles) {
			registration.scope = { type: 'exclude', profiles };
			return builder;
		},
		exceptProfile(profile) {
			return this.exceptProfiles([profile]);
		},
	};
}
```

The chain reads naturally in both forms:

> **Note:** The `createWorkspace(...).withDocumentExtension(...)` extension-chain API shown below was removed along with `createWorkspace` itself: workspaces now compose via `defineDocument((id) => ...)` with inline `attach*` calls, not a builder chain. The singular-wraps-plural pattern this article teaches still applies (see the `registerForProfile` / `registerForProfiles` example further down).

```typescript
createWorkspace({ id: 'app', tables: { notes, images, chat } })
	.withDocumentExtension('persistence', persistenceFactory)

	// Singular: most common case
	.withDocumentExtension('sync', syncFactory)
	.forProfile('synced')

	// Plural: when you need it
	.withDocumentExtension('history', historyFactory)
	.exceptProfiles(['ephemeral', 'scratch']);
```

The consumer picks whichever reads better for their use case. Under the hood, both hit the same code path. If the scoping logic ever changes (say you add validation or deduplication), you fix it in `forProfiles` and `exceptProfiles`. The singular wrappers don't need to know.

## Standalone Functions: Same Pattern, No Chain

The same principle works for top-level functions. Say you have a function that registers document handlers for specific profiles:

```typescript
// The plural version: all logic lives here
function registerForProfiles(
	profiles: string[],
	key: string,
	factory: DocumentExtensionFactory,
) {
	for (const profile of profiles) {
		registry.set(`${profile}:${key}`, factory);
	}
}

// The singular version: normalize and delegate
function registerForProfile(
	profile: string,
	key: string,
	factory: DocumentExtensionFactory,
) {
	return registerForProfiles([profile], key, factory);
}
```

No overloads, no `T | T[]` union types, no `Array.isArray` checks scattered around. The singular function wraps its argument in an array and calls the plural one. That's it.

```typescript
// Both work, both hit the same code path
registerForProfile('synced', 'sync', syncFactory);
registerForProfiles(['synced', 'premium'], 'sync', syncFactory);
```

## Why Not a Single Function with `T | T[]`?

The [single-or-array overload pattern](./single-or-array-overload-pattern.md) handles the case where you want one function name that accepts either form. That pattern is great for CRUD operations where singular and plural are the same word with an array wrapper.

This pattern is different. When you have _distinct method names_ for singular and plural (`forProfile` vs `forProfiles`), you already have two entry points. The question is just where the logic lives. Put it in the plural version; make the singular version a wrapper.

| Approach              | Entry points  | Logic lives in | Normalization             |
| --------------------- | ------------- | -------------- | ------------------------- |
| Single-or-array       | One function  | That function  | `Array.isArray` check     |
| Singular-wraps-plural | Two functions | Plural only    | `[item]` wrap in singular |

Both eliminate duplicate logic. The first collapses two entry points into one. The second keeps two entry points but makes one a trivial delegation.

## The Rule

If you're writing a singular variant of an existing plural function, the implementation should be one line: wrap the argument in an array and call the plural version. If it's more than one line, either the plural version is missing logic or the singular version is doing too much.
