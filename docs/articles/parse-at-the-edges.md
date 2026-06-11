# Parse at the Edges

> See [PR #1216](https://github.com/EpicenterHQ/epicenter/pull/1216) for the full context on this pattern.

Keep data in its serialized form throughout the system. Parse to rich objects only at the moment you need them. Typically UI binding.

## The Insight

I was storing dates as strings in SQLite. My first instinct was to parse them into `Temporal.ZonedDateTime` on every read. But then I traced the data flow:

```
SQLite (string) → parse → object → serialize → API → parse → frontend → serialize → ...
```

The rich object was only needed briefly (date pickers, date math). Every other step was pure churn.

## The Rule

If data enters serialized and leaves serialized, keep it serialized in the middle. Parse at the edges where you actually need the rich representation.

## Where This Applies

- **Dates**: Keep as ISO strings. Parse only for date pickers or date math.
- **Markdown**: Keep as strings. Parse to AST only for rendering.
- **JSON columns**: Pass through as strings. Parse only when accessing fields.
- **IDs**: Keep as strings. Validate only at trust boundaries.
- **Money**: Store as cents + currency. Materialize only for formatting or arithmetic.

## When to Parse Early

- **Trust boundaries**: Validate untrusted input at the edge, but you can still keep it as a canonical string after validation.
- **Heavy computation**: If you'd parse the same value many times, materialize once and cache it.
- **DB queries**: If the database needs to query semantics, add indexed columns alongside the canonical string.
