# My Journey Through Collection APIs

How I went from dot syntax to callable collections to explicit `.get()`, and why we settled where we did.

## Phase 1: Dot Syntax

When I first built the Epicenter tables API, I used the most natural syntax:

```typescript
tables.posts.upsert({ id: '1', title: 'Hello' });
tables.posts.getAll();
```

It felt great. Clean, short, obvious. TypeScript gave me autocomplete for table names.

### The Problem

Then I realized: what if someone names a table "keys" or "toJSON"? The API reserved those names for utility methods:

```typescript
tables.keys(); // List all table names
tables.toJSON(); // Serialize all tables
```

If someone created a table named "toJSON", the API would break. I couldn't just reserve those names. That's a terrible DX.

## Phase 2: Callable Collections

I discovered you can make objects callable in TypeScript using `Object.assign`:

```typescript
const tables = Object.assign(
  (name: string) => getTable(name),  // callable
  { keys: () => [...], toJSON: () => {...} }  // utilities
);

// Usage
tables('posts').upsert({ ... });
tables.keys();
tables.toJSON();
```

Now `tables('toJSON')` returns the table, and `tables.toJSON()` calls the utility. No collision.

I was proud of this. It felt clever.

### The Problem

After using it for a while, I noticed issues:

1. **Discoverability**: When I typed `tables.` in my IDE, I saw `keys`, `toJSON`, etc., but not the main way to access tables. The callable was invisible.

2. **Unfamiliar**: Every time I onboarded someone, I had to explain "oh, you call it like a function." Map uses `.get()`. WeakMap uses `.get()`. Every ORM uses `.get()` or `.find()`. Nobody uses callable objects.

3. **Asymmetric**: Get was callable, but set was `tables.set('name', def)`. Why is get special?

The pattern saved 4 characters (`.get`) but added real cognitive overhead.

## Phase 3: Explicit `.get()`

I stepped back and asked: what's the actual benefit of callable?

- **Namespace collision?** Real, but `.get('toJSON')` vs `.toJSON()` solves it too.
- **Brevity?** Saves `.get`, but so what?
- **Cleverness?** That's a con, not a pro.

So I migrated everything to explicit `.get()`:

```typescript
tables.get('posts').upsert({ id: '1', title: 'Hello' });
tables.get('posts').getAll();
tables.keys();
tables.toJSON();
```

Four more characters. But now:

1. `tables.` shows `get` in autocomplete
2. Anyone who's used Map knows how it works
3. `.get()`, `.set()`, `.has()`, `.delete()` are consistent

## The Lesson

**Familiar beats clever.**

The callable pattern is technically elegant. TypeScript supports it well. It solves a real problem. But it's unfamiliar, and unfamiliarity has a cost that compounds over time.

When I see code 6 months later, I want to immediately understand it. `tables.get('posts')` is instant. `tables('posts')` requires remembering the convention.

## Our Current API

```typescript
// Tables
tables.get('posts').upsert({ id: '1', title: 'Hello' });
tables.get('posts').getAll();

// KV (flattened. No intermediate helper)
kv.get('theme'); // get value
kv.set('theme', 'dark'); // set value
kv.reset('theme'); // reset to default

// Definition helpers
definition.tables.get('posts')?.fields.get('title');
definition.kv.get('theme');
```

## When I'd Still Use Callable

Almost never. But if:

1. You're building a DSL where brevity is critical
2. Your users will write thousands of these calls
3. You've explicitly measured that `.get` verbosity is a problem

Then maybe. But for library APIs, configuration, or anything users read more than write. Just use `.get()`.

## See Also

- [Collection API Patterns](./collection-api-patterns.md): Comparison of all three approaches
- [The Callable Collection Pattern](./callable-collection-pattern.md): Technical reference if you still want to use it
- [PR #1275](https://github.com/EpicenterHQ/epicenter/pull/1275): The migration PR with before/after examples
