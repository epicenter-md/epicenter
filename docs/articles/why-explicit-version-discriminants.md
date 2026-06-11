# Why Epicenter Makes You Type \_v in Every Write

> **Historical: API has moved.** This article documents the explicit `_v` era, where users declared `_v` in every column schema and stamped it in every `set` call. Workspace tables now make `_v` library-managed: users never declare it, never write it, and never see it on returned rows. The library stamps it on write, routes by it on read, and strips it before handing the row back. Migrate functions receive `{ value, version }` instead of `row`. See `packages/workspace/specs/20260525T061910-library-managed-row-version.md` for the rationale.

Epicenter used to make you type `_v: 2` in every versioned table write. We explored three different approaches, an auto-injection system, and a "start simple, add later" pattern before landing on explicit `_v`. The explicit `_v` survived for a while because it solved a problem the alternatives couldn't: one pattern, no ambiguity, greppable version bumps. We've since gone further and pulled the discriminator out of the user-facing API entirely; the section below preserves the reasoning behind the intermediate explicit-`_v` design.

## Three Approaches, One Problem

We started with three ways to version table schemas. All worked. All had trade-offs. Documentation had to explain all three, and new users asked "which one?" The answer was always "it depends," which is a sign the API hasn't made up its mind.

**Field presence** was the simplest. Check whether a field exists:

```typescript
const posts = defineTable(
	type({ id: 'string', title: 'string' }),
	type({ id: 'string', title: 'string', views: 'number' }),
)
	.migrate((row) => {
		if (!('views' in row)) return { ...row, views: 0 };
		return row;
	});
```

This works for two versions. It breaks down at three: what if you add a field in v2 and remove one in v3? Or add an optional field that could legitimately be missing? Structural checks become fragile fast.

**Asymmetric \_v** was the recommended default. Start without `_v`, add it when you need a second version:

```typescript
const posts = defineTable(
	type({ id: 'string', title: 'string' }),
	type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
)
	.migrate((row) => {
		if (!('_v' in row)) return { ...row, views: 0, _v: 2 };
		return row;
	});
```

Less ceremony upfront, which felt like a win. But it introduced a trap: v1 data has no `_v` field, so the migration checks `!('_v' in row)`. If you forget that check, v1 data silently passes through unmigrated. And every version after v1 uses a different migration pattern than v1 itself.

**Symmetric \_v** was the clean option. Include `_v` from the start:

```typescript
const posts = defineTable(
	type({ id: 'string', title: 'string', _v: '1' }),
	type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
)
	.migrate((row) => {
		switch (row._v) {
			case 1:
				return { ...row, views: 0, _v: 2 };
			case 2:
				return row;
		}
	});
```

Every version follows the same pattern. Migration is a switch statement. TypeScript narrows the union. But it requires `_v` in every schema and every write call, which looked like unnecessary boilerplate for tables that might never need a second version.

## The Auto-Injection Detour

We explored a fourth option: have the library inject `_v` automatically. Instead of putting `_v` in your schema, you'd pass a version tag as the first argument:

```typescript
// Proposed (not shipped)
const posts = defineTable()
	.version(1, type({ id: 'string', title: 'string' }))
	.version(2, type({ id: 'string', title: 'string', views: 'number' }))
	.migrate((row) => {
		if (row._v === 1) return { ...row, views: 0 };
		return row;
	});

// Writes would omit _v entirely
posts.set({ id: '1', title: 'Hello', views: 0 });
// Stored as: { id: '1', title: 'Hello', views: 0, _v: 2 }
```

Zero `_v` boilerplate. The library handles everything. We wrote a full spec for this, got deep into the type system design, and then deferred it. Three reasons:

It's magic. What you write isn't what gets stored. When you inspect raw data in Y.js, there's a `_v` field you never defined. That makes debugging harder.

The industry doesn't do this. Zod discriminated unions, TypeScript tagged unions, Effect schema variants: they all expect the discriminant in the schema itself. Auto-injection invents a new convention that users have to unlearn elsewhere.

It creates asymmetry. Tables would get auto-injected `_v`, but KV stores wouldn't (they don't need it). Two different mental models for the same library.

## One Pattern Wins

We dropped three approaches down to one: symmetric `_v` from v1. If your table has versions, every version includes `_v`. Every write includes `_v`. Every migration uses `switch (row._v)`.

The "start simple" argument for asymmetric `_v` lost out to a simpler observation: most tables never need versioning at all. The shorthand `defineTable(schema)` handles single-version tables with zero ceremony. The moment you need two versions, you're already opting into the variadic pattern with `defineTable(v1, v2).migrate()`. Adding `_v` at that point is one field per schema, not a burden.

## The DX Reframe

The `_v: 2` in every `set()` call looked like a tax. Then we realized it's a workflow:

| Scenario           | With explicit \_v                 | With auto-injected \_v      |
| ------------------ | --------------------------------- | --------------------------- |
| Adding v3          | Grep `_v: 2` → every write site   | Trace call sites manually   |
| Code review        | See which version a write targets | Hidden behind library magic |
| Debugging raw data | `_v` matches what code wrote      | `_v` appears from nowhere   |

When you bump to v3, search your codebase for `_v: 2`. Every hit is a call site that needs updating. The "boilerplate" is a searchable version marker that makes version bumps mechanical.

## \_v Goes Last

Convention, not enforced. Business fields first, system metadata last:

```typescript
type({ id: 'string', title: 'string', views: 'number', _v: '2' });
posts.set({ id: '1', title: 'Hello', views: 0, _v: 2 });
```

You see what the row IS, then what version it IS. The `_v` at the end reads like a footnote, not a headline.

## One Less Thing to Remember

We also confirmed that `as const` on `_v` values in migrate returns is unnecessary. TypeScript contextually narrows `2` to the literal type when the return type expects `_v: 2`. One less annotation to remember.

One pattern, explicit, greppable. That's the bet.

## Enforced at the Type Level

We didn't stop at documentation. In [PR #1366](https://github.com/EpicenterHQ/epicenter/pull/1366), we changed the table generic constraint from `CombinedStandardSchema<{ id: string }>` to `CombinedStandardSchema<{ id: string; _v: number }>`. Passing a table schema without `_v` to `defineTable()` is now a compile error.

This closed the loop: `_v` went from "recommended" to "the only way." The pattern taxonomy: field presence, asymmetric `_v`, symmetric `_v`: disappeared from the docs entirely. There's one pattern for tables. KV stores stay flexible since they're small objects where field presence is unambiguous.

The change was zero-risk because every table schema already had `_v: 1` from the same PR. The type enforcement just prevents future code from going back to the old patterns.
