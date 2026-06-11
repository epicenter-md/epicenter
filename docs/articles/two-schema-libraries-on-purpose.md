# Two Schema Libraries, On Purpose

Epicenter uses two schema systems. Not because we couldn't decide, but because the two layers have different jobs and different serialization requirements.

## The Split

**Data schemas** (tables and KV stores) use `CombinedStandardSchema`: in practice, ArkType. **Action input schemas** (queries and mutations) use TypeBox.

```typescript
// Data layer: ArkType via CombinedStandardSchema
const posts = defineTable(
  type({ id: 'string', title: 'string', _v: '1' }),
);

// Action layer: TypeBox
const createPost = defineMutation({
  input: Type.Object({ title: Type.String() }),
  handler: ({ title }) => { /* ... */ },
});
```

This is deliberate. The two layers need different things from their schemas.

## What Each Layer Needs

### Data Schemas Need Rich Validation

Table and KV schemas validate data on read. They deal with versioning, migrations, and morphs. ArkType is good at this because it gives you a concise string DSL, `.merge()` for composing versions, and pipes for coercion (`'string.date.parse'`, `'string.numeric.parse'`).

The constraint on data schemas is `CombinedStandardSchema`: an intersection of Standard Schema (runtime validation) and Standard JSON Schema (JSON Schema generation):

```typescript
export type CombinedStandardSchema<TInput = unknown, TOutput = TInput> = {
  '~standard': StandardSchemaV1.Props<TInput, TOutput> &
    StandardJSONSchemaV1.Props<TInput, TOutput>;
};
```

This is library-agnostic. ArkType, Zod 4.2+, and Valibot all satisfy it. We use ArkType, but nothing in the workspace layer knows that.

### Action Schemas Need to Be JSON Schema

Action inputs have a completely different requirement: they need to cross process boundaries. An action's input schema travels from the workspace definition to the HTTP server, the CLI, and AI tool providers: all as plain JSON Schema.

TypeBox schemas ARE plain JSON Schema objects. There is no conversion step:

```typescript
// TypeBox object IS a JSON Schema object
Type.Object({ title: Type.String() })
// → { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
```

This matters in three places:

**1. HTTP validation.** The Elysia server validates incoming requests with `Value.Check(action.input, query)`. TypeBox's runtime validator operates directly on its own JSON Schema representation. No conversion needed.

**2. AI tool definitions.** When actions become AI tools, their input schemas are forwarded directly to providers (Anthropic, OpenAI, etc.) as JSON Schema. The cast from TypeBox to `JSONSchema` is a safe no-op: they're already the same thing:

```typescript
// In tool-bridge.ts: forwarding action input to AI provider
// Safe cast: our action system only accepts TypeBox schemas (TSchema),
// which ARE plain JSON Schema objects.
...(tool.inputSchema && {
  inputSchema: normalizeSchema(tool.inputSchema as JSONSchema),
}),
```

**3. CLI generation.** The CLI walks TypeBox schemas with `Type.IsObject()`, `Type.IsEnum()`, etc. to generate yargs options. Again, directly introspecting JSON Schema.

Elysia's built-in `t` helper is itself a TypeBox re-export, so action schemas and route schemas are the same system. No extra dependency.

## When Do You Need JSON Schema From Data Schemas?

Rarely. The main case is `describeWorkspace()`, which builds a machine-readable description of a workspace's tables, KV stores, and actions. When describing the data model to an AI (telling it "this workspace has a `tabs` table with these fields"), you want JSON Schema from the table definitions.

For this, we go through the Standard JSON Schema interface:

```typescript
export function standardSchemaToJsonSchema(
  schema: StandardJSONSchemaV1,
): Record<string, unknown> {
  return schema['~standard'].jsonSchema.input({
    target: 'draft-2020-12',
    libraryOptions: { fallback: ARKTYPE_FALLBACK },
  });
}
```

This is a conversion: ArkType produces JSON Schema on demand, with fallback handlers for edge cases like optional properties (`T | undefined` in ArkType → `required` array in JSON Schema). It works, but it's a conversion, not an identity. That's fine for `describeWorkspace()` which runs once, not on every request.

## Why Not One Library?

The honest answer: either direction creates friction.

**ArkType everywhere** would mean fighting Elysia. Elysia speaks TypeBox. Its `t` helper, its route-level validation, its OpenAPI generation: all TypeBox. You'd need conversion layers everywhere actions touch the HTTP boundary. You'd also lose the zero-cost JSON Schema identity that makes AI tool definitions trivial.

**TypeBox everywhere** would mean giving up ArkType's ergonomics for data schemas. TypeBox's composition story is weaker for versioned data models. No string DSL, no morphs, no pipes. You'd write more verbose schemas for the thing you write the most schemas for.

**The abstraction boundary makes the split clean.** `CombinedStandardSchema` is the contract for data. `TSchema` is the contract for actions. They don't leak into each other. A developer defining tables never sees TypeBox. A developer defining actions never sees ArkType.

## The Decision Framework

If it lives in a Yjs document and gets validated on read → `CombinedStandardSchema` (ArkType).

If it crosses a process boundary as input to an operation → `TSchema` (TypeBox).

Two libraries, two layers, one clear rule.
