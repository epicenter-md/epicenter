# Smell Catalog

Grep patterns to enumerate candidates before reading. This is the *discovery* catalog; the [code-audit](../../code-audit/SKILL.md) skill carries the *calibrated* catalog with worked examples for known smells (duck-typing leaks, ceremony tails, library logging discipline, union churn, single-method Picks, copied boundary shapes). Use this file to *find* candidates, then triage against `code-audit` for the calibrated triage recipe.

## Indirection patterns

### One-line passthrough wrappers

```bash
rg "function \w+\([^)]*\)(:\s*[^{]+)?\s*\{\s*return \w+\(" packages apps
```

A function whose body is `return otherFunction(args)` is a candidate. Read the caller. If the wrapper adds no invariant, no naming, and no type narrowing, inline it.

### Derived types

```bash
rg "type \w+ = ReturnType<typeof \w+>" packages apps
```

`type Foo = ReturnType<typeof createFoo>` is fine when the factory is the single source of truth. Becomes a smell when the underlying name is a noun and the alias is the verb (or vice versa); decide which one earns the name.

### Single-method dependency injection

```bash
rg "Pick<\w+, ['\"]\w+['\"]\s*>" packages apps
```

`Pick<Thing, 'method'>` often keeps an object boundary alive after the caller only needs one operation. Calibrate against `code-audit` §5 before fixing.

### Hand-rolled object projection

```bash
rg "Parameters<typeof \w+>\[\d+\]" packages apps
```

`Parameters<typeof fn>[0]` is fine when it derives a public helper type from a stable exported function. Becomes a smell when tests use it to reverse-engineer an unnamed seam.

### Untyped map shapes

```bash
rg "ReadonlyMap<\w+, Uint8Array>" packages apps
rg "Map<string, \w+>" packages apps | rg -v "node_modules"
```

When a named alias exists for the value type, prefer the alias.

## Surface-area patterns

### Potentially dead exports

```bash
rg "^export (function|const|type|class) \w+" packages apps -o
```

Cross-reference each name against `rg "<name>" packages apps --type ts -l`. If the only hit is the definition itself, it is a dead-export candidate. Verify before deleting:

1. Check whether the symbol is part of a package's `exports` map (it might be public API with external consumers).
2. Check `references/never-touch.md` for "external CLI/SDK consumers" rule.

### Re-export chains

```bash
rg "export (\*|\{[^}]+\}) from" packages/*/src/index.ts apps/*/src/index.ts
```

Imports that travel through more than one barrel are an indirection smell. Either flatten or document why the intermediate barrel earns its keep.

### File names that lie

```bash
fd -e ts "(-manager|-helper|-utils|-service)\.ts$" packages apps
```

When the file is one function or one passthrough, the name overstates the responsibility. Rename to a verb that matches the function, or inline into the caller.

## Duplication patterns

### Duplicated string literals

```bash
rg -F "<literal>" packages apps | wc -l
```

For HKDF labels, IndexedDB prefixes, DO names, and error message templates, three or more hits across files signals either:

- A constant worth extracting and importing (preferred)
- A durable-string violation (see `references/never-touch.md`)

Pick a candidate string. Run the grep. Read the hits.

### Parallel definitions of the same shape

```bash
rg "type \w+ = \{[^}]+\}" packages apps -A 10
```

Look for two types with the same fields under different names. Usually a missed arktype merge or a `'+': 'delete'` projection waiting to happen. See the `arktype` skill for the discriminated-union and merge patterns.

### Option names that describe steps, not policy

No grep; this requires reading. Look for option fields whose names describe *implementation* (`refreshFn`, `clientId`) instead of *policy* (`refresh`, `identity`). The implementation-named option often signals a leaky abstraction; the policy-named version often hides the right amount.

## Branded-type patterns

### Brands without enforcement

```bash
rg "Brand<['\"]\w+['\"]>" packages apps
```

A branded type that is created via `as Foo` everywhere has no enforcement. Either replace with a constructor that runs the validator, or drop the brand.

## What this catalog is NOT

This is a *discovery* catalog. It enumerates candidates; it does not decide. Triage against:

- [code-audit](../../code-audit/SKILL.md) for the worked examples and false-positive guidance
- [one-sentence-test](../../one-sentence-test/SKILL.md) for the cohesion gate
- [refactoring](../../refactoring/SKILL.md) for caller counting and surgical-commit mechanics
- `references/never-touch.md` for the things that *look* duplicated but are durable strings
