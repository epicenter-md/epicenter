# 0266. `defineData` compiles once and holds behaviors beside a JSON field-core

- **Status:** Accepted
- **Date:** 2026-08-26
- **Amends:** [ADR-0255](0255-data-definitions-use-one-data-first-public-vocabulary.md) at "the data definition uses closed JSON field descriptors" and at `parseData`'s content-hash memo only; the field descriptors stay closed JSON, and `parseData` stays the validation and compilation boundary.
- **Relates:** [ADR-0264](0264-a-table-declares-its-row-documents-derivation-and-file-codec.md) (the behaviors this makes room for), [ADR-0213](0213-a-lens-is-arktype-json-and-an-application-queries-only-its-own-projection.md)
- **Unbuilt:** `defineData` is an identity function today; eager compilation and the memo removal are not built.

## Context

ADR-0255 makes a definition a set of closed JSON field descriptors that `parseData` validates and compiles, memoizing its result under a content hash (`sha256Hex` of `canonicalJson`) because it was designed to validate untrusted JSON arriving repeatedly at runtime. ADR-0264 adds function-valued behaviors, `derive` and `file`, to the table declaration, and a function is not closed JSON. And an application ships as an imported TypeScript module, a repository built into an SPA, not as a serialized definition fetched at runtime, so the whole-definition-as-a-JSON-file requirement no longer has a consumer.

## Decision

A definition is a TypeScript module. Its field descriptors remain a closed JSON data core that `parseData` validates and compiles exactly as before; the behavior functions (`derive`, `file`) ride alongside the descriptors and are never handed to the descriptor vocabulary. `defineData` compiles the field descriptors once, eagerly, at the authoring call, and returns the compiled definition; every caller holds that compiled value rather than re-invoking `parseData` on the same literal.

The content hash and the parse-result memo are removed, because there is exactly one compile per definition and no untrusted JSON arriving repeatedly at runtime. `canonicalJson` stays where it is independently used: row-address identity, and freezing the definition snapshot. Application identity is the reverse-DNS id, never a content hash.

## Consequences

- The field-core validation, nonconformance reporting, and SQL projection paths are unchanged; they still only ever see closed JSON descriptors, so ADR-0255's boundary survives for the data half.
- The `parseData` memo `Map`, the `sha256Hex` key, `clearDataDefinitionCache`, and the test-only `.canonical` reader delete, once every open-path caller holds the compiled definition instead of re-parsing.
- The one boundary that genuinely receives a definition as data, a host asset endpoint, keeps validating on arrival.
- The definition is no longer serializable to a standalone JSON file, because functions do not cross that boundary. Nothing consumes such a file now that applications ship as modules; a data-only consumer, such as a registry preview without the repository, is refused rather than preserved, and can be reopened if one is ever actually needed.

## Considered alternatives

- **Keep the whole definition closed JSON (ADR-0255 unchanged).** Rejected: it forbids the `derive` and `file` behaviors ADR-0264 establishes, in exchange for a JSON-file portability nothing consumes now that applications ship as repositories.
- **Full TypeScript-first with no data core.** Rejected: the field descriptors must stay data for the projection and validation to read them; keeping them JSON while functions ride alongside is the surgical split, not an abandonment.
- **Keep the content hash.** Rejected: it is only a re-entrant memo key that never escapes `parseData`; compiling eagerly at the authoring call removes the re-entry, so the hash has nothing left to serve.
