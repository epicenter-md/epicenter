# The Optional Input Pattern

Epicenter's `defineQuery` and `defineMutation` functions were inspired by Astro's `defineAction`: a function with `input` and `handler` where the input of `handler` is the inferred validated result of `input`; and when input validation is optional, the type system should reflect that.

## The Pattern

```typescript
// No input schema = handler receives undefined
const ping = defineQuery({
  handler: (input) => {
    // input is undefined
    return Ok({ status: 'alive' });
  },
});

// With input schema = handler receives validated data
const getUser = defineQuery({
  input: z.object({ id: z.string() }),
  handler: (input) => {
    // input is { id: string }
    return Ok({ id: input.id, name: 'Alice' });
  },
});
```

## Why This Works

The generic signature makes `input` optional, but changes the handler type based on whether a schema is provided. After experimenting with various generic signatures and function overloading, we independently arrived to a similar implementation to Astro Actions:

```typescript
export function defineQuery<
  TOutput,
  TSchema extends StandardSchemaV1 | undefined = undefined,
>(config: {
  input?: TSchema;
  handler: (
    input: TSchema extends StandardSchemaV1
      ? StandardSchemaV1.InferOutput<TSchema>
      : undefined,
  ) => Result<TOutput, EpicenterOperationError>;
}): QueryAction<TSchema, TOutput>
```

When `input` is omitted, `TSchema` defaults to `undefined`, so the handler receives `undefined`. When `input` is provided, TypeScript infers the schema type and the handler receives the validated output type.

## The Alternative (Worse)

Without this pattern, you'd need separate functions or the type system would fall back to `any`:

```typescript
// Bad: Two separate functions
defineQueryWithInput({ input: schema, handler: (input) => ... })
defineQueryNoInput({ handler: () => ... })

// Bad: Handler accepts `any` when input omitted
defineQuery({
  handler: (input) => {
    // input is any - no type safety!
  }
})
```

## Astro's Implementation

Astro's `defineAction` uses the same pattern, with one minor difference: when `accept: 'form'` is specified without an input schema, the handler receives `FormData` instead of `undefined`. This makes sense for their form-first workflow.

Epicenter's implementation is stricter: if you don't provide a schema, you explicitly receive `undefined`, forcing you to be intentional about unvalidated input.

## The Insight

The key realization: **the presence or absence of a schema should change the handler's type signature**. This makes invalid states unrepresentable. You can't accidentally use input that wasn't validated, because TypeScript prevents it at compile time.
