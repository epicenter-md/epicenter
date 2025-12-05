# Why We Named Epicenter's Column Schemas the Way We Did

## Primitives: Direct, Not Technical

Epicenter uses database-oriented names that match what developers think about when modeling data, not TypeScript primitive names:

```typescript
id()          // Not 'string' - it's an identifier
text()        // Not 'string' - it's text content
integer()     // Not 'number' - it's a whole number
real()        // Not 'number' - it's a decimal
boolean()     // This one stays the same
date()        // Not 'Date' or 'timestamp' - it's a date
```

The pattern: name it what it represents in your data model, not what TypeScript calls it.

## User-Facing Concepts: Industry Standard

For option-based fields, Epicenter uses what users actually see in tools like Airtable and Notion:

```typescript
select({ options: ['draft', 'published'] })
tags({ options: ['tag1', 'tag2', 'tag3'] })
```

`select` is immediately clear: you're selecting from options. While `enum` could work, it means something specific in TypeScript (a compile-time constant), and these are runtime option lists.

## The YJS Exception: When to Be Explicit

For collaborative editing, Epicenter uses YJS shared types. These aren't Typescript primitives; they're live, mutable data structures that sync across users in real-time:

```typescript
ytext()           // Returns Y.Text - for code editors, simple rich text
yxmlfragment()    // Returns Y.XmlFragment - for rich documents
tags()     // Returns Y.Array<string> - but we don't prefix it
```

### Why Prefix `ytext` and `yxmlfragment` with `y`?

These types expose the actual YJS API to developers. When you get a row back:

```typescript
const row = doc.tables.posts.get('1');
row.content.insert(0, 'Hello'); // This is Y.XmlFragment's API
row.tags.push(['tech']);        // This is Y.Array's API
```

The `y` prefix signals: "You're working with a YJS shared type. You'll interact with its API directly."

### Why NOT Prefix `tags`?

Good question. `tags` also returns a `Y.Array<string>` under the hood. But there's a key difference:

Most developers using `tags` don't need to know it's YJS-backed. They just want a list of selected options. The collaborative sync happens automatically. They might call `.push()` or `.delete()`, but they're thinking "add a tag" not "mutate a YJS shared type."

But with `ytext` and `yxmlfragment`, you're binding to editor instances (CodeMirror, Monaco, TipTap). You need to know you're working with YJS because:
1. You're passing it to editor bindings that expect YJS types
2. You're calling YJS-specific methods for rich formatting
3. The collaborative editing behavior is the whole point

The `y` prefix is a feature, not a bug. It tells developers: "This isn't just data storage. You're getting a live collaborative data structure."

## The Pattern That Emerged

After working with this for a while, I noticed a pattern:

1. **Direct names for primitives**: `text`, `integer`, `real` (what it represents)
2. **User-facing names for concepts**: `select`, `tags` (industry standard)
3. **Library-prefixed names for collaborative types**: `ytext`, `yxmlfragment` (explicit about the API)

This creates a hierarchy of explicitness:
- Primitives: simple and direct
- Collaborative arrays: slightly special (it's YJS, but you don't think about it)
- Collaborative text: explicitly special (you need to know it's YJS)

## The Lesson

Not every type needs the same level of explicitness.

Primitives should be as simple as possible. User-facing concepts should match industry terminology. But when you're exposing a specific library's API, especially for something as complex as collaborative editing, being explicit saves confusion later.

The `y` prefix isn't just a namespace. It's documentation. It tells you: "You're about to work with YJS's API. Here's your heads up."

When you see `ytext()` or `yxmlfragment()` in a schema, you immediately know:
1. This field supports real-time collaboration
2. You'll interact with YJS APIs
3. You need to pass this to editor bindings

That's worth two extra characters.
