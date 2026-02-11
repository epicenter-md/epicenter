# Builder Chains Preserve Type Relationships That JSON Cannot

**TL;DR**: When a function's types depend on sequence (like "accept any version, return the latest"), **builders let TypeScript track accumulating tuples that plain objects lose**.

## The Problem

You want to define a table with multiple schema versions and a migration function. In pure JSON, you might imagine:

```typescript
// Hypothetical pure JSON definition
const posts = {
  versions: [schemaV1, schemaV2],
  migrate: (row) => { ... }  // What's the type of `row`? What's the return type?
}
```

TypeScript can't infer:

- **Input type**: Should be `V1 | V2` (union of all versions)
- **Output type**: Should be `V2` (the latest version only)

These types depend on _position_ in the array. JSON doesn't encode position-dependent types. TypeScript sees `versions: Schema[]` and loses track of which is first, which is last.

## Why the Builder Works

```typescript
defineTable()                          // TableBuilder<[]>
  .version(schemaV1)                   // TableBuilder<[V1]>
  .version(schemaV2)                   // TableBuilder<[V1, V2]>
  .migrate((row) => ...)               // row: V1 | V2, return: V2
```

Each `.version()` call _accumulates_ into a tuple. TypeScript tracks the tuple growing: `[]` → `[V1]` → `[V1, V2]`. When `.migrate()` is called, it can derive:

```
Input  = TVersions[number]     →  V1 | V2
Output = LastSchema<TVersions> →  V2
```

The tradeoff: builders aren't JSON-serializable (they contain functions). But for type relationships that depend on sequence, they're the only way to get compile-time safety.
