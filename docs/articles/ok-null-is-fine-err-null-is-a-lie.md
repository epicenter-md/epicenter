Never discriminate a `Result` by checking if `data` is null. `Ok(null)` is a perfectly valid value: "the record didn't exist, and that's not an error" is a common pattern. `Err(null)` is a lie. It claims failure with no reason to give. The wellcrafted shape can't tell the two apart, and no type-level trick we tried managed to close the gap without creating worse problems. Always discriminate by the error side: `isErr(result)` or `result.error !== null`, and construct `Err` with a real error value (ideally a tagged error from `defineErrors`).

In wellcrafted today:

```ts
type Ok<T>  = { data: T; error: null };
type Err<E> = { error: E; data: null };
```

Both variants carry a `null` somewhere. That's the shape the runtime uses to discriminate. And that's where the asymmetry hides.

## The collision

`Ok(null)` and `Err(null)` are structurally identical:

```ts
Ok(null)   // { data: null, error: null }
Err(null)  // { error: null, data: null }
```

Same keys, same values, same shape. The built-in `isErr` is `result.error !== null`, which returns `false` for both. A failure passed as `Err(null)` silently becomes a success. Empirically confirmed, not theoretical.

This is a consequence of the destructure-friendly shape wellcrafted chose. The same `{ data, error }` Supabase and SvelteKit load functions use. Rust and Haskell avoid the collision by putting a discriminant tag next to the payload instead of inside it. Wellcrafted can't add a tag without giving up the shape; the shape is the whole point.

## Why the type-level ban didn't survive

We tried `Err<E extends NonNullable<unknown>>` to make `Err(null)` a compile error. Shipped it briefly, then reverted it. Two reasons:

- **Shallow enforcement.** The constraint catches the literal `Err(null)`, but `Err(value as any)`, `Err(value as NonNullable<T>)`, and direct object construction all slip through. The ban's own migration in wellcrafted's `src/query/utils.ts` had to add `as NonNullable<TError>` casts in three places: exactly the kind of "silence the type error without fixing the bug" pattern the ban was meant to discourage.
- **Wide cost.** Every `catch (error: unknown)` boundary hits friction with `NonNullable<unknown>`. The natural fix is a cast, not a refactor, so the type error teaches the wrong lesson more often than the right one.

The right lesson (use `defineErrors` and pass `{ cause }`) is better delivered by documentation and idiom than by a type error whose Stack Overflow answer is `as any`.

See the wellcrafted philosophy doc [`docs/philosophy/err-null-is-ok-null.md`](https://github.com/wellcrafted-dev/wellcrafted/blob/main/docs/philosophy/err-null-is-ok-null.md) for the full write-up.

## The rule

Never check `data === null` to mean "this is an error."

```ts
// Wrong. Ok(null) is legal; this passes for success too.
if (result.data === null) { /* handle error */ }

// Right. `null` on the error side is the only discriminator that survives.
if (result.error !== null) { /* handle error */ }

// Also right. The named guard carries intent.
if (isErr(result)) { /* handle error */ }
```

And never call `Err(null)` or `Err(undefined)`. Either use `Ok(null)` / `Ok(undefined)` (if what you meant was success-with-no-payload) or mint a tagged error via `defineErrors` and pass *that* to `Err`:

```ts
const Errors = defineErrors({
  Unexpected: ({ cause }: { cause: unknown }) => ({
    message: extractErrorMessage(cause),
    cause,
  }),
});

const result = await tryAsync({
  try:   async () => fetchThing(),
  catch: (error) => Errors.Unexpected({ cause: error }),
});
```

The tagged error `{ name: 'Unexpected', message, cause }` is a constructed object: always non-null. `Err(taggedError)` produces a result whose `error` side is non-null, so `isErr` reads it correctly. The shape's invariant is preserved, and you didn't have to know the invariant existed.

## The logger discriminator that almost got this wrong

While building `wellcrafted/logger`, I needed to distinguish two shapes at runtime:

```ts
type LoggableError = AnyTaggedError | Err<AnyTaggedError>;
```

`AnyTaggedError` is the raw `{ name, message, ...fields }` object. `Err<AnyTaggedError>` is the `{ error: tagged, data: null }` wrapper that `defineErrors` factories return. Both flow into `log.warn(err)`; the logger needs to peel off the wrapper if present.

The first draft used `"data" in err`. That's a presence check, not a null check. But the JSDoc explaining *why it was safe* leaned on "Err has `data: null`", which is the wrong mental model. `Ok<null>` also has `data: null`. The check happened to work only because `Ok` couldn't reach the function via the type system.

The fix was to pick a discriminator that doesn't flirt with the null semantics at all:

```ts
function unwrapLoggable(err: LoggableError): AnyTaggedError {
  return "name" in err ? err : err.error;
}
```

`name` is always present on a tagged error (stamped by `defineErrors` from the factory key. A hard invariant). It's never present at the top level of `Err<E>`: `Err` has exactly `{ error, data }`. Purely structural. No null-checks anywhere.

## What this means for your code

Wherever you touch a wellcrafted `Result`, check the error side:

```ts
const { data, error } = await tryAsync({ try: ..., catch: ... });
if (error) {
  // handle: by convention the error side is never null
}
use(data);
```

Wherever you discriminate a union that includes an `Err<>` wrapper against another shape, pick an invariant non-null field (like `name`), not a null-valued one.

And if you're about to write `Err(null)`: the shape is telling you something. Either you meant `Ok(null)`, or you haven't defined the error type yet. Both are fixable by looking at the call site. Neither is fixable by the constructor.
