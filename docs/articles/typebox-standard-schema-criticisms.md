# Why TypeBox Won't Implement Standard Schema (And What To Use Instead)

Standard Schema is a common TypeScript interface designed to unify validation libraries like Zod, Valibot, and ArkType. When asked to implement it, TypeBox's maintainer (sinclairzx81) declined and published a detailed critique of the specification itself.

This article summarizes the technical concerns and explains how to use TypeBox with Standard Schema anyway.

## The Core Problem: Schemas Shouldn't Validate Themselves

Standard Schema requires attaching a `~standard` property with a `validate()` function directly on schema objects:

```typescript
// Standard Schema approach
const result = schema['~standard'].validate(value);
```

TypeBox follows a different philosophy: schemas are data, validators are functions that consume them:

```typescript
// TypeBox approach
const result = validate(schema, value);
```

This isn't just aesthetic. TypeBox produces standard JSON Schema that works with any compliant validator (Ajv, for example). Adding `~standard` properties would break JSON Schema compliance and force TypeBox-specific validation onto users who just want schematics.

## The Specification Criticisms

### 1. Misleading Naming

"Standard Schema" sounds like a schema format (like JSON Schema), but it's actually just a TypeScript interface for validation libraries. It doesn't define schema structure. It defines how validators should expose their `validate()` function.

This conflates:

- **Schematics**: data structures describing types
- **Validators**: functions that check values against schematics

### 2. Conflating Parse and Validate

Standard Schema's `validate()` returns the transformed output value:

```typescript
interface SuccessResult<Output> {
	readonly value: Output; // Returns the parsed/transformed value
	readonly issues?: undefined;
}
```

This is parsing (transform input → output), not validating (check if valid → boolean).

For high-performance scenarios, you often just want to know "is this valid?" without constructing result objects:

```typescript
// TypeBox: efficient validation (no allocations)
const isValid = Check(schema, value); // Returns boolean

// Standard Schema: always allocates result object
const result = schema['~standard'].validate(value);
if (!result.issues) {
	/* valid */
}
```

### 3. No Separate API for Error Generation

Standard Schema always returns errors in the result:

```typescript
interface FailureResult {
	readonly issues: ReadonlyArray<Issue>; // Always generated
}
```

Error generation is expensive (string formatting, path tracking). Many environments don't need detailed errors. Production APIs, security contexts following "minimal disclosure" principles, etc.

TypeBox separates these concerns:

```typescript
// Fast path: just check validity
const valid = Check(schema, value); // No error generation

// Slow path: only generate errors when needed
if (!valid) {
	const errors = Errors(schema, value); // Generate on demand
}
```

### 4. No DoS Mitigation

Consider validating an array of 10,000 items where each fails:

```typescript
const schema = z.array(z.object({ x: z.number() }));
const value = Array(10000).fill({ x: 'not a number' });

// Standard Schema generates 10,000+ error objects immediately
const result = schema['~standard'].validate(value);
// result.issues = [{ message: '...', path: [0, 'x'] }, ... 10,000 more]
```

Malicious input could force massive error object generation, causing memory exhaustion or CPU spikes. An iterator-based approach would allow lazy evaluation with limits.

### 5. Unnecessary Async Support

Standard Schema allows async validation:

```typescript
validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
```

Schema validation is fundamentally synchronous and CPU-bound. Async implies I/O (network, disk), which validation shouldn't need. This forces all consumers to handle async even for sync schemas.

### 6. No JIT Provisions

Standard Schema only defines a runtime `validate()` function. It doesn't account for compilation. Generating optimized validation code ahead of time.

TypeBox's JIT compiler shows why this matters:

```typescript
const validator = Compile(
	Type.Object({
		x: Type.Number(),
		y: Type.Number(),
	}),
);

// Generated optimized code runs ~100x faster
```

Benchmark from TypeMap:

```
Zod native:        4669ms for 10M iterations
TypeBox compiled:    47ms for 10M iterations
```

Standard Schema has no way to express or leverage this optimization.

## The Solution: TypeMap

Despite not implementing Standard Schema natively, TypeBox offers full support through TypeMap. An official adapter listed on [standardschema.dev](https://standardschema.dev):

```bash
npm install @sinclair/typemap
```

```typescript
import { Compile } from '@sinclair/typemap';
import Type from 'typebox';

// Compile TypeBox to Standard Schema compatible validator
const validator = Compile(
	Type.Object({
		x: Type.Number(),
		y: Type.Number(),
		z: Type.Number(),
	}),
);

// Standard Schema interface
const result = validator['~standard'].validate({ x: 1, y: 2, z: 3 });
```

TypeMap also provides:

- Bidirectional translation between TypeBox, Zod, and Valibot
- High-performance JIT compilation (100x faster than native Zod)
- TypeScript syntax parsing for schema creation

## Summary

| Criticism                 | Impact                 | TypeBox Alternative                  |
| ------------------------- | ---------------------- | ------------------------------------ |
| Misleading naming         | Confusion              | Clear separation: schema ≠ validator |
| Parse/validate conflation | Performance overhead   | Separate `Check()` and `Parse()`     |
| Always generates errors   | Wasted computation     | Lazy `Errors()` on demand            |
| No DoS mitigation         | Security risk          | Iterator-based error generation      |
| Async validation          | Unnecessary complexity | Sync-only validation                 |
| No JIT support            | Missed 100x perf       | `Compile()` for JIT optimization     |

The core tension: Standard Schema was designed by libraries (Zod, Valibot, ArkType) that couple schemas with validation. TypeBox follows separation of concerns. Schemas are data structures passed to independent validators. This isn't just philosophical; it enables JSON Schema compatibility, performance optimization, and architectural flexibility that the specification doesn't accommodate.

## References

- [TypeBox Discussion #1152: Implement Standard Schema interface](https://github.com/sinclairzx81/typebox/discussions/1152)
- [TypeMap: Official Standard Schema adapter](https://github.com/sinclairzx81/typemap)
- [Standard Schema specification](https://standardschema.dev)
