# Local Mail test support

One live check that is not part of `bun test`: `check-gmail-discovery.ts` makes a
real Google call, so it is not hermetic and stays out of the offline suite.

The mock-Gmail write harness that used to sit here was deleted with the
standalone runtime it drove (ADR-0317). What it covered, a triage act being
visible to the next read and a pass delivering it, is now covered offline in
`src/reconcile.test.ts` against in-memory databases, so nothing here needs a
throwaway copy of a real mailbox any more.

## Gmail API drift check

`check-gmail-discovery.ts` fetches Gmail's Discovery document and asserts that
every method and schema field `src/gmail-client.ts` / `src/schema.ts` rely on is
still present and still the type we expect. Our schemas are deliberately partial
and permissive (they tolerate unknown Gmail fields, and every read field is
optional, so a removed field passes `Value.Check` and reaches a reader as
`undefined`), which is exactly what makes Gmail *removing*, *moving*, or
*retyping* something we depend on invisible until a live sync misbehaves.

The schema-side contract is not re-listed: the check walks the actual `schema.ts`
TypeBox objects (JSON Schema at runtime), so `schema.ts` stays the single source
of the fields we read. The only hand-maintained pieces are the small set of
methods we call (the client builds those paths as string templates, nothing to
derive) and the root-schema name map.

```sh
bun run --cwd apps/local-mail check:gmail-drift
```

It runs weekly (and on demand) via `.github/workflows/local-mail.gmail-drift.yml`,
not per-PR: it is a network call and drift is slow-moving. Exits non-zero listing
each drift.

## Files

| File | What it is |
| --- | --- |
| `check-gmail-discovery.ts` | The live drift check above. |
| `mock-gmail.ts` | A mock Gmail REST server, kept for manual exploration against a fake provider. It is not wired into any script. |
