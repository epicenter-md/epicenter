# Local Mail test support

One live tool: the Gmail API drift check. It is the only thing here that touches
the network, and it reads Google's public Discovery document rather than any
mailbox, so it needs no account, no credential, and no mirror. It is developer
and CI tooling, not `bun test`: it makes a live Google call, so it is not
hermetic and stays out of the offline suite.

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

## What used to live here

A write-path harness: a throwaway copy of the real mirror, forged credentials, a
mock Gmail server, and a spawned `local-mail app` that a headless smoke script
drove over HTTP. All of it existed so one real triage write could be executed
safely against a process that read real configuration.

It is gone. The standalone host it drove was deleted by ADR-0191, and the
harness had been broken since the mail surface became multi-account: it still
called `/api/messages`, a route that stopped existing that day, and nothing
noticed because it was a manual script rather than a CI job.

Its replacement is in `src/http/api.test.ts`, which drives the same write routes
in process against an injected fake Gmail client. That needs no copy, no forged
credentials, no mock server, and no port, because a test holding a fake client
has nothing real to reach. It also runs in CI, which the harness never did.
