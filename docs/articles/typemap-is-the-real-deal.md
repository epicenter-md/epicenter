# TypeMap is the Real Deal

TypeMap is a syntax compiler and translation layer for runtime types. That's the official description. Here's what it actually means: you can pass TypeScript syntax as a string, and get back a high-performance validator with full Standard Schema support.

```typescript
import { Compile } from '@sinclair/typemap';

const validator = Compile(`{ name: string, age: number }`);

const result = validator['~standard'].validate({ name: 'Alice', age: 30 });
```

That's it. String in, Standard Schema validator out.

## The Compile Function is Unhinged (In a Good Way)

`Compile()` is one of the most overloaded functions you'll encounter. It accepts:

**TypeScript syntax strings:**

```typescript
const v1 = Compile(`{ x: number, y: number }`);
const v2 = Compile(`string | number | null`);
const v3 = Compile(`{ items: { id: string, value: number }[] }`);
```

**TypeBox schemas:**

```typescript
import { Type } from 'typebox';

const v4 = Compile(
	Type.Object({
		x: Type.Number(),
		y: Type.Number(),
	}),
);
```

**Zod schemas:**

```typescript
import { z } from 'zod';

const v5 = Compile(
	z.object({
		x: z.number(),
		y: z.number(),
	}),
);
```

**Valibot schemas:**

```typescript
import * as v from 'valibot';

const v6 = Compile(
	v.object({
		x: v.number(),
		y: v.number(),
	}),
);
```

Every single one of these returns a validator with `['~standard'].validate()`. You can use Zod's API for definition and get TypeMap's performance for validation.

## The Mapping Functions

TypeMap isn't just about compilation. It translates between libraries:

```typescript
import { Syntax, TypeBox, Zod, Valibot } from '@sinclair/typemap';

// Start with syntax
const syntax = `{ name: string, age: number }`;

// Translate to any library
const tbSchema = TypeBox(syntax); // TypeBox schema
const zodSchema = Zod(syntax); // Zod schema
const valibotSchema = Valibot(syntax); // Valibot schema

// Or go the other direction
const backToSyntax = Syntax(zodSchema); // Back to string
```

These nest arbitrarily. You could go `Syntax → Zod → Valibot → TypeBox → Syntax` and maintain type fidelity throughout. The use case isn't obvious until you're migrating between libraries or building tools that need to support multiple validation ecosystems.

## Remote Types

Here's where it gets interesting. You can parameterize syntax with types from other libraries:

```typescript
import { Zod } from '@sinclair/typemap';
import { z } from 'zod';

const StringEnum = z.enum(['a', 'b', 'c']);

// Embed Zod type inside syntax
const schema = Zod({ StringEnum }, `{ values: StringEnum[] }`);
```

The `{ StringEnum }` parameter lets you reference the Zod type by name in the syntax string. TypeMap translates it automatically. This bridges the gap between declarative syntax strings and the programmatic types you've already defined.

## Performance

This isn't just about DX. TypeMap compiles validators using JIT code generation:

| Library         | 10M iterations |
| --------------- | -------------- |
| Zod native      | ~4,669ms       |
| Valibot native  | ~1,534ms       |
| TypeMap         | ~47ms          |

That's roughly 100x faster than Zod for the same validation. The compiled validators use optimized code paths that avoid the overhead of runtime type checking.

Our own benchmarks showed similar results. Testing with Standard Schema's `~standard.validate()` interface:

| Test Case                | ArkType    | TypeMap (compiled) |
| ------------------------ | ---------- | ------------------ |
| Simple object (valid)    | 2.0M ops/s | 73.4M ops/s        |
| Complex nested (valid)   | 1.7M ops/s | 18.6M ops/s        |
| Array of 100 items       | 745K ops/s | 3.16M ops/s        |

TypeMap wins across the board when using the Standard Schema interface.

## Why This Matters

Most validation libraries force a choice: nice syntax or good performance. Zod has great DX but pays for it at runtime. TypeBox has great performance but requires builder syntax. ArkType tries to bridge this with its own DSL.

TypeMap sidesteps the tradeoff. Write schemas however you want. Strings, Zod, Valibot, TypeBox. And compile them to high-performance validators with Standard Schema support. The compilation happens once; validation runs fast forever after.

## Installation

```bash
npm install @sinclair/typemap
```

If you're using TypeBox schemas, also install:

```bash
npm install typebox
```

Note: use `typebox`, not `@sinclair/typebox`. The latter is the legacy package.

## Summary

| Feature                | What It Does                                      |
| ---------------------- | ------------------------------------------------- |
| `Compile()`            | Any input → Standard Schema validator             |
| `Syntax()`, `TypeBox()`, `Zod()`, `Valibot()` | Translate between libraries |
| Remote types           | Embed library types in syntax strings             |
| JIT compilation        | ~100x faster than native Zod                      |
| Standard Schema        | Works with any framework expecting `~standard`    |

TypeMap is what happens when someone takes "why not both?" seriously. Define schemas with whatever syntax you prefer; validate them with compiled performance.

## References

- [TypeMap GitHub](https://github.com/sinclairzx81/typemap)
- [Standard Schema specification](https://standardschema.dev)
- [Why TypeBox Won't Implement Standard Schema](./typebox-standard-schema-criticisms.md)
