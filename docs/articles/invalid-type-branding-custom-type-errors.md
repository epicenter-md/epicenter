# Custom Type Error Messages in TypeScript

Two patterns for replacing TypeScript's unreadable structural diffs with human-readable error messages when generic constraints fail.

---

## The Problem

You write a generic function with a constraint. The constraint is reasonable. When someone violates it, TypeScript produces a wall of structural diffs that nobody can act on:

```
Argument of type 'Type<{ title: string; }, {}>' is not assignable to
parameter of type 'CombinedStandardSchema<BaseRow>'.
  Type 'Type<{ title: string; }, {}>' is not assignable to type
  '{ "~standard": StandardSchemaV1.Props<BaseRow, BaseRow> &
  StandardJSONSchemaV1.Props<BaseRow, BaseRow>; }'.
    Types of property '"~standard"' are incompatible.
      ... [15 more lines]
```

The fix is "add `id` and `_v` to your schema." TypeScript will never tell you that. But you can make it.

---

## Pattern 1: Conditional Type Branding

Write a helper type that resolves to either `T` (valid) or a descriptive string literal (invalid):

```typescript
type ValidateInput<T extends SomeSchema> =
  InferOutput<T> extends RequiredShape
    ? T
    : "createThing() error: Schema must include 'id: string' and 'version: number' fields.";

export function createThing<T extends SomeSchema>(
  schema: ValidateInput<T>,
): ThingDefinition<[T & SomeSchema<RequiredShape>]>;
```

When the check fails, the parameter type resolves to a string literal. TypeScript reports:

```
Argument of type 'Type<{ title: string; }>' is not assignable to
parameter of type '"createThing() error: Schema must include 'id: string' and 'version: number' fields."'
```

Single, clean error. The message IS the parameter type.

### How it works

1. Widen the generic constraint to `SomeSchema` (no type parameter) so TypeScript doesn't reject at the constraint level first
2. The conditional type checks `InferOutput<T> extends RequiredShape`
3. When valid: resolves to `T`: no change, everything works
4. When invalid: resolves to a string literal: `T & string` is `never`, and the error shows the string

### When it breaks

This adds type instantiation depth. If your schemas are already deep (ArkType, Zod, StandardSchema), the conditional type + intersection in the return type can compound and trigger:

```
error TS2589: Type instantiation is excessively deep and possibly infinite.
```

We hit this in practice. Every call site across 30+ test files broke. The conditional type itself is cheap, but the intersection `T & SomeSchema<RequiredShape>` in the return type feeds into other generic types that expand further.

**Use when**: Your types are shallow and you've verified TS2589 doesn't fire.

---

## Pattern 2: Fallback Overload

Keep your original overloads untouched. Add a catch-all overload before the implementation with a string literal parameter:

```typescript
// Overload 1: Happy path
export function createThing<T extends SomeSchema<RequiredShape>>(
  schema: T,
): ThingDefinition<[T]>;

// Overload 2: Fallback: custom error message
export function createThing(
  schema: "createThing() error: Schema must include 'id: string' and 'version: number' fields.",
  ...rest: unknown[]
): never;

// Implementation (not callable: TypeScript only tries declared overloads)
export function createThing(
  first: SomeSchema | string,
  ...rest: unknown[]
): unknown {
  // ...runtime logic
}
```

TypeScript tries overloads in order. When the valid overload fails, it tries the fallback. The error shows:

```
No overload matches this call.
  Overload 1 of 2: ...
    [structural diff]
  Overload 2 of 2: ...
    Argument of type '...' is not assignable to parameter of type
    '"createThing() error: Schema must include ..."'
```

### Trade-off

The structural diff still shows (from overload 1). Your custom message appears alongside it, not instead of it. The error is noisier: two blocks instead of one.

In practice, the structural diff often already surfaces the answer in its last line (e.g., `Type '{ name: string; }' is missing the following properties from type '{ id: string; _v: number; }': id, _v`). The fallback overload adds a clearer version of the same information but also adds visual noise.

**Use when**: Your types are deep (ArkType, Zod, StandardSchema), conditional branding triggers TS2589, and you want zero risk of breaking inference.

---

## Trade-offs

| | Conditional Type Branding | Fallback Overload |
|---|---|---|
| Error output | Single clean message | Structural diff + your message |
| Type instantiation depth | Adds depth (can trigger TS2589) | Zero overhead |
| Works with deep schema libs | Risky | Yes |
| Original overloads changed | Yes (constraint widened) | No |
| Inference risk | Higher | None |
| Implementation complexity | Conditional types + intersections | Extra overload + widened impl signature |

---

## Writing the Error Message

Three rules:

1. **Name the function.** Users might be calling several similar functions. Start with `createThing() error:`.
2. **State the constraint violated.** Not the TypeScript type: the human concept. "Schema must include" beats "must extend BaseRow".
3. **Tell them how to fix it.** "Add `id: string` and `_v: number`" is actionable. "Must extend BaseRow" requires looking up what BaseRow is.

---

## The Honest Assessment

Neither pattern is perfect.

Conditional type branding gives the cleanest error but adds type depth that can break with deep schema libraries. You also have to widen the generic constraint and add intersections in the return type, which changes inference behavior.

Fallback overloads add zero type depth but produce noisier errors. The custom message appears alongside the structural diff, not instead of it. And TypeScript may reorder overloads in the error display, so your message might not appear where you expect.

For simple constraints with shallow types, conditional type branding is strictly better. For complex constraints with deep types (StandardSchema, ArkType, Zod), the fallback overload is the safer choice. If the added noise is worth the clearer message. Sometimes TypeScript's structural diff already gets there in the last line, and neither pattern is needed.

Evaluate on a case-by-case basis. Try conditional branding first. If it triggers TS2589, fall back to the overload pattern. If the structural diff already surfaces the missing fields clearly, you might not need either.
