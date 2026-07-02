---
name: testing
description: 'Test file conventions: setup functions, factories, organization, type testing, naming, and pruning low-value tests. Use when: "write tests", "add a test", "fix this test", "delete tests", "prune tests", "audit tests", or modifying *.test.ts files.'
metadata:
  author: epicenter
  version: '2.0'
---

# Test File Conventions

## When to Apply This Skill

Use this pattern when you need to:

- Structure tests with `setup()` functions instead of mutable `beforeEach` setup.
- Audit a test file for assertions that cannot fail or fakes that don't earn their lines.

## References

Load these on demand based on what you're working on:

- If working with **negative type tests** (`@ts-expect-error`, `bun:test` type strategy, no `as any`), read [references/type-testing.md](references/type-testing.md)
- If working with **test setup architecture** (`setup()` patterns, composable setup, `beforeEach` avoidance, shared schemas), read [references/setup-pattern.md](references/setup-pattern.md)
- If working with **test organization structure** (flat tests, `describe()` boundaries, helper-over-nesting), read [references/test-structure.md](references/test-structure.md)
- If **auditing existing tests** for hedged assertions, pass-through getters, stalled fakes, dead fake surface, or docstrings that contradict the code, read [references/honest-tests.md](references/honest-tests.md)
- If **deleting or pruning tests** that may not earn their keep, read [references/test-deletion-grill.md](references/test-deletion-grill.md)

External reading:

- Kent C. Dodds, ["Avoid Nesting When You're Testing"](https://kentcdodds.com/blog/avoid-nesting-when-youre-testing): setup functions over beforeEach, flat tests
- Kent C. Dodds, ["AHA Testing"](https://kentcdodds.com/blog/aha-testing): avoid hasty abstractions in tests
- Kent C. Dodds, [Testing JavaScript](https://testingjavascript.com): Test Object Factory Pattern
- Matt Pocock, ["How to test your types"](https://www.totaltypescript.com/how-to-test-your-types): vitest `expectTypeOf` for type testing
- Matt Pocock, [`shoehorn`](https://github.com/total-typescript/shoehorn): partial mocks for test ergonomics

> **Related Skills**: See `services-layer` for the service patterns being tested. See `typescript` for type testing conventions.

## Tests vs. Benchmarks

Two distinct file extensions, two distinct purposes:

- **`*.test.ts`**: asserts behavior with `expect()`. Runs under `bun test`
  (repo default, CI). A test file without at least one `expect()` call does
  not belong under this extension.
- **`*.bench.ts`**: measures and reports. Prints tables, timings, or
  storage sizes. Runs under `bun bench` only. No assertions required
  (perf thresholds on shared hardware flake; prefer visual trends).

A single file is one or the other, never both. Benchmarks live under
`src/__benchmarks__/` within a package; tests are colocated with the module
they cover. The `bun test` default-discovery glob picks up only `*.test.ts`
and friends, so renaming a report from `.test.ts` → `.bench.ts` is what
excludes it from CI.

## File-Level Doc Comments

Every `.test.ts` file MUST start with a JSDoc block explaining what is being tested and the key behaviors verified. This serves as documentation for the module's contract.

### Structure

```typescript
/**
 * [Module Name] Tests
 *
 * [1-3 sentences explaining what this file tests and why these tests matter.]
 *
 * Key behaviors:
 * - [Behavior 1]
 * - [Behavior 2]
 * - [Behavior 3]
 *
 * See also:
 * - `related-file.test.ts` for [related aspect]
 */
```

### Good Example

```typescript
/**
 * Cell-Level LWW CRDT Sync Tests
 *
 * Verifies cell-level LWW conflict resolution where each field
 * has its own timestamp. Unlike row-level LWW, concurrent edits to
 * DIFFERENT fields merge independently.
 *
 * Key behaviors:
 * - Concurrent edits to SAME field: latest timestamp wins
 * - Concurrent edits to DIFFERENT fields: BOTH preserved (merge)
 * - Delete removes all cells for a row
 */
```

### Bad Example (Too Minimal)

```typescript
// Tests for create-tables
```

### Section Headers

For long test files (100+ lines), use comment headers to separate logical sections:

```typescript
// ============================================================================
// MESSAGE_SYNC Tests
// ============================================================================
```

## Multi-Aspect Test File Splitting

When a module has distinct behavioral aspects, split into focused test files rather than one monolithic file:

| Pattern                       | Use Case                                             |
| ----------------------------- | ---------------------------------------------------- |
| `{module}.test.ts`            | Core CRUD behavior, happy paths, edge cases          |
| `{module}.types.test.ts`      | Type inference verification, negative type tests     |
| `{module}.{scenario}.test.ts` | Specific scenarios (CRDT sync, offline, integration) |

### When to Split

- File exceeds ~500 lines
- Tests cover genuinely distinct concerns (CRUD vs sync vs types)
- Different setup requirements per concern

### When NOT to Split

- Splitting would create files with fewer than 3 tests
- All tests share the same setup and concern

## Test Naming

Test descriptions MUST be behavior assertions, not vague descriptions. The name should tell you what broke when the test fails.

### Rules

1. **State what happens**, not "should work" or "handles correctly"
2. **Include the condition** when testing edge cases
3. **No filler words**: "should", "correctly", "properly" add nothing

### Good Names

```typescript
test('upsert stores row and get retrieves it', () => { ... });
test('filter returns only published posts', () => { ... });
test('concurrent edits to different fields: both preserved', () => { ... });
test('delete vs update race: update wins (rightmost entry)', () => { ... });
test('observer fires once per transaction, not per operation', () => { ... });
test('get() throws for undefined tables with helpful message', () => { ... });
```

### Bad Names

```typescript
test('should work correctly', () => { ... });         // What works? What's correct?
test('should handle batch operations', () => { ... }); // Handle how?
test('basic test', () => { ... });                     // Says nothing
test('should create and retrieve rows correctly', () => { ... }); // Vague "correctly"
```

### Pattern: `{action} {outcome} [condition]`

```
"upsert stores row and get retrieves it"
 ^^^^^^ ^^^^^^^^^^   ^^^ ^^^^^^^^^^^^^
 action  outcome    action  outcome

"observer fires once per transaction, not per operation"
 ^^^^^^^^ ^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 subject   outcome              condition

"get() returns not_found for non-existent rows"
 ^^^^^ ^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^
 action     outcome            condition
```
