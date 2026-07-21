# 0168. Lenses are complete pure JSON interpretations

- **Status:** Proposed
- **Date:** 2026-07-20
- **Amends:** [ADR-0120](0120-fields-validate-present-values-and-table-lenses-own-presence.md), [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md), and [ADR-0160](0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md)

## Context

Epicenter Home must load a Lens without executing application source code. The
same Lens should be authorable with TypeScript inference, durable as an ordinary
JSON file, inspectable by people and agents, and validatable after download.
TypeBox builder objects and compiled validators are convenient runtime tools,
but functions, symbols, prototypes, and caches cannot be part of that durable
contract.

## Decision

A Lens and every nested table, value, field schema, and metadata value are pure
JSON data. `JSON.stringify` followed by `JSON.parse` preserves the complete Lens
semantics. No custom serialization step, source module, function, compiled
validator, or hidden side table is required to recover it.

`defineLens`, `defineTable`, and `defineValue` are TypeScript authoring helpers.
They preserve literal keys and derive ergonomic static types, but return the
same canonical JSON shape accepted from disk. TypeBox field builders are
canonicalized into their JSON Schema representation at this boundary.

`parseLens(unknown)` is the single legitimacy law for arbitrary Lens JSON. It:

1. validates the closed outer Lens, table, and value structures;
2. recognizes every nested field schema as supported Epicenter field
   vocabulary; and
3. checks semantic relationships that JSON Schema alone cannot express.

Those semantic checks include namespace and local-key grammar, unknown or
duplicate optional field names, and any future cross-field constraints. Invalid
installed Lenses remain visible as broken artifacts with a concrete parse error;
Home does not silently discard them.

Every Lens requires `namespace`, `title`, and `description`. Every table and
value requires `title`; their descriptions and field-level title and description
annotations are optional semantic metadata. Presentation policy such as icons,
column width, default sorting, or a `preview` field list is not part of a Lens.

Table fields are required by default. A table carries one canonical
`optional: string[]` whose entries must be unique keys from its `fields` object.
The TypeScript helper constrains entries to `keyof fields`; `parseLens` enforces
the same rule at runtime. Missing and `null` remain distinct, so nullable field
schemas do not replace optionality.

Validators are ephemeral derived functions. Binding or reading a valid Lens may
compile them synchronously. The platform initially stores no compiled validator
and maintains no validator `WeakMap`. A transparent cache may be introduced
later only if it changes neither Lens validity nor observable semantics.

## Consequences

- Home can load, inspect, validate, and render a downloaded Lens without running
  an application's JavaScript.
- TypeScript and JSON have one semantic representation rather than parallel
  source and manifest formats.
- Any valid parsed Lens can reconstruct all runtime validation behavior.
- Optionality is explicit, type-safe for authors, and directly checkable from
  untrusted JSON.
- UI preferences can evolve independently without making a data interpretation
  look different merely because it was installed on another device.

## Considered alternatives

- **Persist TypeBox builder objects as-is.** Rejected because builder runtime
  details are not the portable Lens contract even when their enumerable parts
  currently resemble JSON Schema.
- **Store source code and execute it to recover a Lens.** Rejected because Home
  must inspect untrusted installed artifacts without granting code execution.
- **Use nullable schemas instead of optional fields.** Rejected because `null`
  is a value while absence is a row-shape fact.
- **Persist or require compiled validators.** Rejected because they are derived
  executable state and would make JSON insufficient.
- **Include display layout and preview metadata.** Rejected because a Lens owns
  semantic interpretation, not one viewer's presentation policy.
