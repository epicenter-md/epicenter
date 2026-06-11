# Make TypeScript Errors Read Like English

TypeScript can tell you exactly what's wrong with a value at compile time. The trick is to brand the constraint-violation type as a template literal whose contents are the error message itself, suffixed with a U+200B zero-width space. When the assignment fails, the error tooltip reads as a sentence pointing at the bad value.

This is the pattern `arktype` uses internally. Here it is, generalized.

## The problem

You wrote a helper that constrains object keys to a shape, like snake_case for action registry keys, or kebab-case for route slugs:

```ts
function defineActions<T extends Record<string, Action>>(actions: T): T {
  for (const k of Object.keys(actions)) {
    if (!/^[a-z][a-z0-9_]*$/.test(k)) {
      throw new Error(`Invalid action key "${k}"`);
    }
  }
  return actions;
}
```

That catches the bad key at runtime. But the author wrote `'tabs.close'` an hour ago, the typecheck passed, the bundle shipped, and the daemon crashed at boot. Edit-site feedback would have saved them an hour.

You want this to fail in the IDE, with a message that names the bad key.

## What doesn't work

`never` as the rejected type:

```ts
type IsSnakeCase<S extends string> = /* ... */;
type Validated<S extends string> = IsSnakeCase<S> extends true ? S : never;
```

Error tooltip: `Type 'Action' is not assignable to type 'never'`. Useless without context.

Branded object:

```ts
type Invalid<S extends string> = { __invalid: S };
type Validated<S extends string> = IsSnakeCase<S> extends true ? S : Invalid<S>;
```

Error tooltip: `Property '__invalid' is missing in type 'Action' but required in type '{ __invalid: "tabs.close" }'`. Reads as "missing property", not "bad key shape."

Plain template literal error message:

```ts
type Invalid<S extends string> = `Invalid action key "${S}"`;
type Validated<S extends string> = IsSnakeCase<S> extends true ? S : Invalid<S>;
```

This works, but TypeScript will also happily accept `'Invalid action key "tabs.close"'` as a value of type `Invalid<...>` anywhere else, and autocomplete may suggest the literal in contextual positions. Not catastrophic, but messy.

## What works: branded template literal

```ts
type InvalidKey<S extends string> =
  `Invalid action key "${S}", must be snake_case ASCII matching /^[a-z][a-z0-9_]*$/​`;
```

Note the trailing `​`: that's U+200B, a Unicode zero-width space. It's invisible in IDE error tooltips and editor windows, but it brands the literal: no user types it, so the type isn't structurally reachable from any normal string.

The error tooltip reads as a sentence:

```
Type 'Action' is not assignable to type
'Invalid action key "tabs.close", must be snake_case ASCII matching /^[a-z][a-z0-9_]*$/'.
```

## The full helper

```ts
type Lower =
  | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm'
  | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';
type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type WordChar = Lower | Digit | '_';

type IsTail<S extends string> = S extends ''
  ? true
  : S extends `${WordChar}${infer Rest}`
    ? IsTail<Rest>
    : false;

type IsSnakeCase<S extends string> = S extends `${Lower}${infer Rest}`
  ? IsTail<Rest> extends true
    ? true
    : false
  : false;

type InvalidKey<S extends string> =
  `Invalid action key "${S}", must be snake_case ASCII matching /^[a-z][a-z0-9_]*$/​`;

export function defineActions<T extends Record<string, Action>>(
  actions: {
    [K in keyof T & string]: IsSnakeCase<K> extends true ? T[K] : InvalidKey<K>;
  },
): T {
  for (const k of Object.keys(actions)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(k)) {
      throw new Error(`Invalid action key "${k}"`);
    }
  }
  return actions as T;
}
```

Author-site:

```ts
defineActions({
  tabs_close: defineMutation({ /* ... */ }),    // fine
  'tabs.close': defineMutation({ /* ... */ }),  // TS error at this property
  TabsClose: defineMutation({ /* ... */ }),     // TS error
  '0tab': defineMutation({ /* ... */ }),        // TS error
});
```

## Why U+200B specifically

The U+200B character is structurally distinct from any string a user could type. Two reasons that matters:

1. **Autocomplete hygiene.** If `Invalid action key "tabs.close"` is ever the inferred type at a position where TypeScript suggests string literals, the editor would propose the message as a valid value. Adding U+200B makes the type non-typeable.

2. **Predicate hygiene.** Other type machinery in your codebase may narrow against arbitrary string subtypes. The brand keeps the error type from accidentally matching those narrows.

You'll find this exact pattern in `@ark/util`:

```ts
// node_modules/@ark/util/out/errors.d.ts
export type ErrorMessage<message extends string = string> =
  `${message}${ZeroWidthSpace}`;
```

We could import it, but `@ark/util` isn't part of arktype's public surface. Inlining the trick is two lines.

## The pitfall: checking the wrong thing

You might be tempted to write:

```ts
type Validated<S extends string> = IsSnakeCase<S> extends true ? S : InvalidKey<S>;

function defineActions<T extends Record<string, Action>>(
  actions: {
    [K in keyof T & string]: Validated<K> extends string ? T[K] : Validated<K>;
  },
): T { /* ... */ }
```

Both branches of `Validated<S>` produce a string (`S` is a string; `InvalidKey<S>` is a template literal). So `Validated<K> extends string` is always true, and `T[K]` is always returned. The constraint is dead.

Check the **predicate** directly:

```ts
[K in keyof T & string]: IsSnakeCase<K> extends true ? T[K] : InvalidKey<K>;
```

## Can `arkregex` do this for me?

`arkregex` parses regex strings at the type level and infers template literal types. `regex('^ok$', 'i')` infers as `'ok' | 'oK' | 'Ok' | 'OK'`. Cool.

For character classes like `[a-z]`, it intentionally widens to `string` to avoid combinatorial explosion. Verified locally:

```ts
import { regex } from 'arkregex';
const snake = regex('^[a-z][a-z0-9_]*$');
//    ^? Regex<string, ...>          <- not narrowed

snake.test('tabs.close');  // compiles fine, runtime would throw
```

So the regex-derived type idea is dead for shape constraints. Write the recursive template literal by hand.

## Keep the runtime check

The type check catches authoring inside the helper's parameter context. It does not catch:

- `Object.fromEntries(somethingDynamic)`: TS widens to `Record<string, V>`, predicate becomes vacuous
- `as` casts: explicit bypass
- Helper called from `.js` files in mixed codebases

So pair the type-level check with a runtime check inside the helper. Two sources of truth for the same rule, sitting next to each other in the file. TypeScript cannot derive a runtime value from a type, and arkregex doesn't narrow ranges. Pay the cost.

## When to reach for this

- Constraining object keys (action registries, slug maps, route tables).
- Constraining string-literal arguments (semver, color hex, ISO date strings).
- Anywhere you'd otherwise write `validate()` as a separate call and want it to surface at the edit site instead.

The pattern adds about 15 lines of TypeScript and one runtime regex per constraint. The payoff: bad inputs fail at the property in the IDE, with a message that reads like a sentence. Authors don't need to remember to call a validator. They just type, and the editor tells them what's wrong.
