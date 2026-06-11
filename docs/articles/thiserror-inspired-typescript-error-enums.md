# Rust's thiserror Pattern in TypeScript

In `wellcrafted`, I was inspired by Rust error-handling patterns to TypeScript and kept running into the same wall. Rust's `thiserror` crate gives you something genuinely elegant: a single `enum` where the name is the namespace, each variant carries its own fields, and the display message lives right next to the variant it describes. When you want to handle a specific error, you `match` on the variant name. It is as readable as error handling gets.

TypeScript has none of that, not natively. What you usually end up with is a mess of `Error` subclasses, manually threaded discriminant strings, or opaque `unknown` catches that you narrow with type guards written from scratch. None of it has the structural clarity that Rust gives you almost for free.

Wellcrafted's `defineErrors` is an attempt to bring that same structural clarity to TypeScript. The API maps almost 1:1 to what `thiserror` gives you. This article walks through that mapping so you can see exactly where the design comes from.

## The Rust Starting Point

Here is an HTTP error type using `thiserror`:

```rust
use thiserror::Error;

#[derive(Error, Debug)]
enum HttpError {
    #[error("Failed to connect: {cause}")]
    Connection { cause: String },

    #[error("HTTP {status}: {body}")]
    Response { status: u16, body: String },

    #[error("Failed to parse response body: {cause}")]
    Parse { cause: String },
}
```

A few things are happening here that are easy to miss if you have not worked in Rust:

- `HttpError` is the namespace. The variants: `Connection`, `Response`, `Parse`: live under it. They are short, one-word names because the enum name already gives the context.
- Each variant is a struct with named fields. `Connection` carries a `cause`. `Response` carries a `status` and `body`. The fields are part of the type, and they are exactly what you pass at the call site.
- The `#[error("...")]` annotation defines the human-readable display string for each variant. It can interpolate fields by name with `{cause}`, `{status}`, etc.
- You construct a value like `HttpError::Connection { cause: "timeout".into() }`. You discriminate with `match`.
- **The variant's fields ARE the constructor inputs.** There is no factory function, no transformation step. You pass exactly what the variant stores.

That is the whole pattern. A single type, short variant names under a descriptive namespace, typed fields per variant, and a display message co-located with the definition.

## The TypeScript Equivalent

Here is the same type with `defineErrors`:

```typescript
import { defineErrors, extractErrorMessage, type InferErrors } from 'wellcrafted/error';

const HttpError = defineErrors({
  Connection: ({ cause }: { cause: unknown }) => ({
    message: `Failed to connect: ${extractErrorMessage(cause)}`,
    cause,
  }),

  Response: ({ response, body }: { response: { status: number }; body: unknown }) => ({
    message: `HTTP ${response.status}: ${extractErrorMessage(body)}`,
    status: response.status,
    body,
  }),

  Parse: ({ cause }: { cause: unknown }) => ({
    message: `Failed to parse response body: ${extractErrorMessage(cause)}`,
    cause,
  }),
});

type HttpError = InferErrors<typeof HttpError>;
```

Read it out loud next to the Rust version. The structure is nearly identical. `HttpError` is the namespace. `Connection`, `Response`, `Parse` are short variant names. Each variant's fields are typed inline. The message sits right next to its definition.

But look at `Response`. In Rust, the variant stores `status: u16` and `body: String`, and the call site passes exactly those fields. In TypeScript, the factory accepts a `response` object and a raw `body`, then *derives* `status` from `response.status` and formats `body` through `extractErrorMessage`. The stored fields differ from the constructor inputs. That is something Rust cannot do, and it is the key advantage of factory functions over struct literals.

## What Maps 1:1

| Rust concept | TypeScript equivalent |
|---|---|
| `enum HttpError` | `const HttpError = defineErrors(...)` |
| `Connection { cause: String }` | `Connection: ({ cause }: { cause: unknown }) => (...)` |
| `#[error("Failed: {cause}")]` | `` message: `Failed: ${extractErrorMessage(cause)}` `` |
| `HttpError::Connection { cause: "timeout".into() }` | `HttpError.Connection({ cause: error })` |
| `match error { Connection { cause } => ... }` | `switch (error.name) { case 'Connection': ... }` |
| `fn handle(err: HttpError)` | `function handle(err: HttpError)` |

Construction side by side:

```
Rust: HttpError::Connection { cause: "timeout".into() }
TS:   HttpError.Connection({ cause: error })
```

Discrimination side by side:

```rust
// Rust
match error {
    HttpError::Connection { cause } => println!("Connection failed: {cause}"),
    HttpError::Response { status, .. } => println!("HTTP {status}"),
    HttpError::Parse { cause } => println!("Parse failed: {cause}"),
}
```

```typescript
// TypeScript
switch (error.name) {
  case 'Connection': console.log(`Connection failed: ${error.cause}`); break;
  case 'Response':   console.log(`HTTP ${error.status}`); break;
  case 'Parse':      console.log(`Parse failed: ${error.cause}`); break;
}
```

The `name` field on each error object is the discriminant. It is stamped automatically from the key you give in the config: `'Connection'`, `'Response'`, `'Parse'`. You do not write it by hand; `defineErrors` handles it. That is directly analogous to how Rust stamps the variant identity into the enum value at construction time.

## What Diverges and Why

The mapping is not perfect. TypeScript is a different language with different constraints. Here is where the two diverge and the reasoning behind each difference.

**Factory functions instead of struct literals.** In Rust, `HttpError::Connection { cause: "timeout".into() }` is a struct literal: you are directly constructing a value of the `Connection` variant type. The variant's fields are the constructor inputs. There is no transformation step; you pass exactly what gets stored.

TypeScript has no struct literal syntax, so `defineErrors` gives you factory functions instead: `HttpError.Connection({ cause: error })`. The call site looks nearly identical: same namespace-dot-variant pattern, just parentheses instead of braces.

But factory functions are not just a syntactic workaround. They unlock something Rust struct literals cannot do: **the constructor inputs can differ from the stored fields.** The factory accepts raw inputs and derives what gets stored. Compare:

```rust
// Rust: you must extract .status() at the call site because
// struct literals store exactly what you pass
HttpError::Response { status: response.status(), body: extract_body(&response) }
```

```typescript
// TypeScript: the factory accepts the raw response and derives status internally
HttpError.Response({ response, body: await response.json() })
// stores: { status: response.status, body, message: `HTTP ${response.status}: ...` }
```

In Rust, if you want `status: u16` on the variant but you have a `Response` object, you extract `.status()` at the call site. There is nowhere else to do it. In TypeScript, the factory function is that "somewhere else." It accepts raw inputs, calls `extractErrorMessage`, pulls `.status` off the response, and composes the message: all in one place. The call site just hands over what it has.

This is not just a syntactic difference. It is a design principle: **constructors accept raw inputs, derive stored fields.** Call sites should pass objects as-is; the factory owns the decomposition and formatting.

**Template literals instead of proc macros.** Rust's `#[error("Failed to connect: {cause}")]` is a compile-time format string powered by a procedural macro. TypeScript has no proc macros. Template literals: `` `Failed to connect: ${extractErrorMessage(cause)}` ``: are the natural equivalent. They run at construction time rather than compile time, but the result is the same: a human-readable message derived from the variant's fields.

**`Err<...>` wrapping instead of direct returns.** In Rust, a function returning `Result<T, HttpError>` just returns the error variant directly. Rust's `?` operator and return type tell the compiler which side of the Result you are on. TypeScript does not have that. `defineErrors` factories always return `Err<...>`: an object shaped `{ ok: false, error: ... }`: so that `trySync` and `tryAsync` can tell errors apart from successful values without any ambiguity.

**`Object.freeze` instead of ownership.** Rust's ownership model prevents mutation after construction. TypeScript has no ownership system. `defineErrors` freezes every error object at runtime and marks it `Readonly<...>` at the type level. Different mechanisms, same goal: errors are values, not mutable state.

**Discriminated union narrowing instead of `match`.** Rust's `match` is exhaustive by default: the compiler forces you to handle every variant. TypeScript has no native pattern matching yet, but discriminated unions on `error.name` get you most of the way there. A `switch` on a string literal union narrows the type in each branch, and you can use `never` checks for exhaustiveness if you want it.

| Difference | Rust | TypeScript | Why |
|---|---|---|---|
| Construction | Struct literal | Factory call | TS has no struct literals |
| Input → stored fields | Identical (no transformation) | Can differ (factory derives fields) | Factory functions can transform |
| Message format | Compile-time proc macro | Runtime template literal | TS has no proc macros |
| Return type | Returns enum variant directly | Returns `Err<...>` wrapper | No `?` operator in TS |
| Immutability | Ownership model | `Object.freeze` + `Readonly` | No ownership in TS |
| Exhaustiveness | `match` is exhaustive by default | `switch` + discriminated unions | No pattern matching in TS (yet) |

## The Core Insight

Here is the thing that unlocked the `defineErrors` design, and it comes straight from Rust: **the enum name is the namespace, the variant name is the discriminant.**

In Rust, you would never name a variant `ConnectionError` inside an enum called `HttpError`. That would be `HttpError::ConnectionError`, which is redundant. You name it `Connection`. The enum already tells you it is an `HttpError`. The variant tells you which kind.

That same logic applies in TypeScript. When you write:

```typescript
const HttpError = defineErrors({
  Connection: ...,
  Response:   ...,
  Parse:      ...,
});
```

`HttpError` is the context. `Connection` is the discriminant. The name on the error object will be `'Connection'`, not `'HttpConnectionError'` or `'HttpError.Connection'`. Short, unambiguous, and exactly what you `switch` on.

This is the pattern that was missing from TypeScript error handling. Not just a way to make errors with `name` fields. But a way to define a family of errors under a shared namespace with the same structural clarity that Rust's enum system provides.

The enum name is the namespace. The variant name is the discriminant. Everything else follows from there.
