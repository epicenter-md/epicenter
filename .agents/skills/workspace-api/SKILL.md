---
name: workspace-api
description: 'Epicenter workspace API patterns: `defineTable`, `defineKv`, migrations, actions, `createWorkspace`, materializers, `openCollaboration`, and workspace connections. Use when editing workspace schemas, table/KV access, actions, attachments, or collaboration setup.'
metadata:
  author: epicenter
  version: '8.0'
---

# Workspace API

Use this skill for Epicenter workspace definitions, table and KV access, inline action registries, attachment composition, collaboration setup, and workspace connections.

## Reference Repositories

- [Yjs](https://github.com/yjs/yjs): CRDT framework used by the workspace data layer
- [Yjs Protocols](https://github.com/yjs/y-protocols): sync, awareness, and protocol helpers used around collaboration

## Upstream Grounding

When workspace behavior depends on Yjs transactions, shared types, update encoding, document lifecycle, or conflict semantics, use source-backed grounding before relying on memory. If DeepWiki MCP is available, ask a narrow question against `yjs/yjs`; for collaboration sync or awareness protocol behavior, ask against `yjs/y-protocols`. If DeepWiki is unavailable or the repo is not indexed, use upstream source or official docs directly. Treat DeepWiki as orientation, then verify decisive details against local workspace code, installed types, tests, or official docs before changing code.

Skip DeepWiki for Epicenter schema, action, migration, and attachment conventions already documented below.

## Related Skills

- `yjs`: Yjs CRDT patterns and shared types
- `svelte`: reactive wrappers such as `fromTable` and `fromKv`, plus commit-on-blur workspace inputs
- `attach-primitive`: the full contract and invariants every `attach*` function must follow
- `typebox`: TypeBox primitives used by `column.*`, `defineKv`, and action input schemas

## When To Apply This Skill

Use this skill when you are:

- Defining a table or KV store with `defineTable()` or `defineKv()`.
- Adding a version or migration to an existing table definition.
- Reading, writing, or observing table or KV data.
- Creating actions with `defineMutation` or `defineQuery`.
- Composing a live document with `createWorkspace` and surrounding `attach*` primitives (persistence, sync, materializers).
- Adding `createDisposableCache(builder)` for per-row or fan-out documents.
- Attaching persistence, collaboration, or materializers around a workspace.
- Writing server-side Bun scripts with `connectWorkspace()`.

## Core Rules

- Workspace action `defineQuery` / `defineMutation` factories are not Whispering `$lib/rpc` adapters from `wellcrafted/query`. Do not apply workspace action input-schema rules to Whispering RPC modules.
- `_v` is library-managed. Never declare it as a column, never set it on a write, never read it off a row. Single-version tables drop the versioning surface entirely; multi-version tables expose it only inside the `migrate` function as `({ value, version })`.
- Columns are TypeBox schemas. Prefer the `column.*` sugar (`column.string`, `column.number`, `column.boolean`, `column.enum`, `column.json`, `column.nullable`, `column.dateTime`, `column.ianaTimeZone`); raw `Type.X()` is allowed and the `FlatJsonTSchema` constraint enforces SQLite-mappable shapes either way.
- Derive row types with `InferTableRow<typeof tableDefinition>` in the same module that defines the table. Consumers import the type from the workspace definition module.
- Do not re-derive row types from runtime table methods or relay them through state files.
- KV stores use `defineKv(schema, defaultValue)` where `defaultValue` is a **factory** `() => Static<S>`. Prefer one scalar per dot-namespaced key unless the value is a true atomic object.
- Every table `id` and string foreign key uses a branded type plus a co-located generator. The brand lives as a pure type alias (`type X = string & Brand<'X'>`); the generator uses `generateId<X>()`. Call sites use the generator, never a direct cast.
- Put isomorphic actions directly on the returned workspace as `actions: defineActions({ ... })` inside `create<App>Workspace()`. Avoid a separate `const actions` unless the same registry must be passed to another owner before return. Extract `createXActions(workspace)` only when the action set is shared, large enough to earn a file, or owns a real invariant. Runtime-specific actions live in the runtime builder where browser, Node, Tauri, or extension APIs are in scope.
- Construct a workspace with `createWorkspace({ id, tables, kv, keyring? })` (or a per-app wrapper like `createHoneycrispWorkspace`). Plaintext apps omit `keyring`; encrypted apps pass the signed-in keyring callback. The bundle exposes `{ ydoc, tables, kv, [Symbol.dispose] }` and `using workspace` cascades disposal to every store. Only the three materializers (`attachBunSqliteMaterializer`, `attachTursoMaterializer`, `attachMarkdownMaterializer`) take the bundle; persistence, log, and sync primitives take `workspace.ydoc`.
- Local action calls see the handler shape directly. Remote dispatch wraps raw values and failures in `Promise<Result<T, DispatchError>>`. Read the action return reference before changing handler failure behavior.
- Every action method inside the workspace action object should have JSDoc that adds developer-facing value beyond the short `description` field.
- Keep workspace schema and inline actions isomorphic. If an action file is extracted, it must stay isomorphic too. Keep `client.ts` runtime-specific and outside the `workspace/` folder.
- Compose attachments inline in the builder after calling `createWorkspace`. Avoid wrapper helpers that hide ordering unless the abstraction owns a real invariant.
- Use `connectWorkspace()` for one-off Bun scripts that need a connected workspace without app UI bootstrapping.

## Reference Map

- [Schema definition patterns](references/schema-definition-patterns.md): `defineTable`, `defineKv`, row type inference, KV scalar design, and branded IDs.
- [Actions, layout, and attachments](references/actions-layout-and-attachments.md): inline actions, JSDoc, workspace file layout, attachment ordering, and `connectWorkspace`.
- [Deriving action input schemas](references/deriving-action-inputs.md): use `tables.X.schema` and `schema.properties.X` to compose `defineQuery`/`defineMutation` input schemas inline. No helper layer.
- [Action return shapes](references/action-return-shapes.md): local vs remote action return contracts and error normalization.
- [Table, KV, CRUD, and observation](references/table-kv-crud-observation.md): table/KV read, write, observe, and derived-state details.
- [Table migrations](references/table-migrations.md): migration rules and version evolution examples.
- [Primitive API](references/primitive-api.md): lower-level primitive contracts and composition details.
