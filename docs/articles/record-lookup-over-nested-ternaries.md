# Record Lookup Over Nested Ternaries

Always use `satisfies Record` for value mappings. It's exhaustive at compile time, flat to read, and one line to extend. Nested ternaries and switch statements both lose to it when the job is "map known value → output."

## Nested Ternaries Are the Worst Option

This came from real code in `SyncStatusIndicator.svelte`:

```typescript
type SyncStatus = { phase: 'offline' } | { phase: 'connecting' } | { phase: 'connected' };

const tooltip = $derived(
	syncStatus.current.phase === 'connected'
		? 'Connected'
		: syncStatus.current.phase === 'connecting'
			? 'Connecting\u2026'
			: 'Offline',
);
```

If `SyncStatus` gains a fourth phase. Say `'reconnecting'`: the ternary silently maps it to `'Offline'`. No warning, no error. The else branch swallows anything it doesn't recognize. At two branches a ternary is fine; at three it's already hard to scan; at four it's unreadable.

## Switch Statements Are Better, But Not Best

A switch makes each case explicit:

```typescript
const tooltip = $derived.by(() => {
	switch (syncStatus.current.phase) {
		case 'connected': return 'Connected';
		case 'connecting': return 'Connecting\u2026';
		case 'offline': return 'Offline';
	}
});
```

TypeScript will even warn about unhandled cases if the return type is annotated. But this is seven lines of control flow for what's fundamentally three key-value pairs. Switches earn their syntax when branches have side effects or multi-line logic. For pure value mapping, they're the wrong abstraction.

## Always Prefer `satisfies Record`

```typescript
const tooltip = $derived(
	({
		connected: 'Connected',
		connecting: 'Connecting\u2026',
		offline: 'Offline',
	} satisfies Record<SyncStatus['phase'], string>)[syncStatus.current.phase],
);
```

This is the correct default for value mappings. `satisfies Record<SyncStatus['phase'], string>` does two things at compile time: it verifies every phase in `SyncStatus` is present, and it checks every value is a `string`. Add `'reconnecting'` to the union and TypeScript immediately errors on the missing key. No silent fallthrough, no runtime surprise.

Adding a new status means adding one line to the object. No restructuring branches, no new `case` keyword, no re-indenting.

`as const` is unnecessary here. `satisfies` already validates the shape and value types. Adding `as const` would narrow values to literal types (`'Connected'` instead of `string`), which doesn't matter when the output is rendered text.

When the map is used once, inline it. When it's shared across files or has five-plus entries, extract to a named constant.

| Approach | Exhaustive | Syntax | Verdict |
| --- | --- | --- | --- |
| Nested ternary | No (silent fallthrough) | Nests at 3+ branches | Avoid |
| Switch | Yes (with annotation) | Verbose for value maps | Use for side-effect branches |
| `satisfies Record` | Yes (compile error) | Flat, declarative | **Always use for value mappings** |
