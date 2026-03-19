---
name: testing
description: Test file conventions for setup functions, factory patterns, test organization, type testing, and naming. Use when writing or modifying *.test.ts files, creating test setup functions, or reviewing test structure.
metadata:
  author: epicenter
  version: '1.0'
---

# Test File Conventions

## When to Apply This Skill

Use this pattern when you need to:

- Write or refactor `*.test.ts` files in this codebase.
- Structure tests with `setup()` functions instead of mutable `beforeEach` setup.
- Split large test files into focused behavior/type/scenario files.
- Enforce behavior-based test naming and clear failure intent.
- Add or review negative type tests using `@ts-expect-error`.

## File-Level Doc Comments

Every `.test.ts` file MUST start with a JSDoc block explaining what is being tested and the key behaviors verified. This serves as documentation for the module's contract.

> **Related Skills**: See `services-layer` for the service patterns being tested. See `typescript` for type testing conventions.

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

## Negative Type Tests

For library code, test that incorrect types are rejected. Use `@ts-expect-error` to verify the compiler catches type errors.

### When to Use

- `.types.test.ts` files testing type inference
- Any test verifying a public API's type constraints
- Especially important for generic APIs where incorrect input should fail at compile time

### Pattern

```typescript
test('rejects invalid row data at compile time', () => {
	const doc = createTables(new Y.Doc(), [
		table({
			id: 'posts',
			name: '',
			fields: [id(), text({ id: 'title' })] as const,
		}),
	]);

	// @ts-expect-error — missing required field 'title'
	doc.get('posts').upsert({ id: Id('1') });

	// @ts-expect-error — wrong type for 'title' (number instead of string)
	doc.get('posts').upsert({ id: Id('1'), title: 42 });

	// @ts-expect-error — unknown table name
	doc.get('nonexistent');
});
```

### Rules

1. ALWAYS include a comment explaining what error is expected: `// @ts-expect-error — [reason]`
2. One `@ts-expect-error` per assertion — don't stack them
3. Group negative type tests in their own `describe('type errors', () => { ... })` block
4. These tests verify the compiler catches errors — they don't need runtime assertions

### In `bun:test` (No `expectTypeOf`)

Since we use `bun:test` (not Vitest), we don't have `expectTypeOf`. Use these alternatives:

- **Positive type tests**: Let TypeScript check the types — if it compiles, the types work. Add comments like `// Type: { id: string; title: string }` for documentation.
- **Negative type tests**: `@ts-expect-error` to verify rejection
- **CI enforcement**: `bun typecheck` (runs `tsc --noEmit`) catches type regressions

## No `as any` in Tests

Tests MUST NOT use `as any` to bypass type checking. Tests should prove the types work, not circumvent them.

### Alternatives

| Instead of                          | Use                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `(obj as any).privateMethod()`      | Test through the public API                                                                             |
| `tables.get('bad' as any)`          | Keep `as any` ONLY when testing runtime error handling for invalid input — add a comment explaining why |
| `createMock() as any`               | Create a properly typed mock or use a minimal type                                                      |
| `(content as any).store.ensure(id)` | Expose a test-only accessor or test through public API                                                  |

### Acceptable `as any` (With Comment)

```typescript
// Testing runtime error for invalid table name — bypasses TypeScript intentionally
expect(() => tables.get('nonexistent' as any)).toThrow(
	/Table 'nonexistent' not found/,
);
```

### Never Acceptable

```typescript
// Bad — hiding a real type problem
const result = someFunction(data as any);
expect(result).toBe('expected');
```

## The `setup()` Pattern

Every test file that needs shared infrastructure MUST have a `setup()` function. This replaces `beforeEach` for code reuse, following Kent C. Dodds' principle: "We have functions for that."

### Rules

1. `setup()` ALWAYS returns a destructured object, even for single values
2. Tests ALWAYS destructure the return: `const { thing } = setup()`
3. `setup()` is a plain function, not a hook — each test calls it independently
4. No mutable `let` variables at describe scope — setup returns fresh state per test

### Why Always an Object (Even for One Value)

- **Extensibility**: Adding a second value later doesn't require changing any existing callsites
- **Self-documenting**: `const { files } = setup()` tells you what you're getting by name
- **Consistency**: Every test file follows the same pattern — no guessing

### Single Value

```typescript
// Good — always an object, even for one thing
function setup() {
	const ws = createWorkspace({ id: 'test', tables: { files: filesTable } });
	return { files: ws.tables.files };
}

test('creates a file', () => {
	const { files } = setup();
	files.set({ id: '1', name: 'test.txt', _v: 1 });
	expect(files.has('1')).toBe(true);
});
```

```typescript
// Bad — returns value directly
function setup() {
	const ws = createWorkspace({ id: 'test', tables: { files: filesTable } });
	return ws.tables.files; // No destructuring = breaks convention
}
```

### Multiple Values

```typescript
function setup() {
	const ydoc = new Y.Doc();
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('test-table');
	const ykv = new YKeyValueLww(yarray);
	return { ydoc, yarray, ykv };
}

test('stores a row', () => {
	const { ykv } = setup(); // Take only what you need
	// ...
});

test('atomic transactions', () => {
	const { ydoc, ykv } = setup(); // Take multiple when needed
	ydoc.transact(() => {
		ykv.set('1', { name: 'Alice' });
	});
});
```

### Composable Setup Functions

When tests need additional setup beyond the base, create composable setup variants that build on `setup()`:

```typescript
function setup() {
	const tableDef = defineTable(fileSchema);
	const ydoc = new Y.Doc({ guid: 'test-workspace' });
	const tables = createTables(ydoc, { files: tableDef });
	return { ydoc, tables };
}

function setupWithBinding(
	overrides?: Partial<Parameters<typeof createDocumentBinding>[0]>,
) {
	const { ydoc, tables } = setup();
	const binding = createDocumentBinding({
		guidKey: 'id',
		tableHelper: tables.files,
		ydoc,
		...overrides,
	});
	return { ydoc, tables, binding };
}
```

### When `setup()` Is NOT Needed

- Pure function tests with no shared infrastructure (e.g., `parseFrontmatter('# Hello')`)
- Tests where each case has completely different inputs with no overlap
- Type-only test files (`*.test-d.ts`)

## Avoid `beforeEach` for Setup

Use `beforeEach`/`afterEach` ONLY for cleanup that must run even if a test fails (server shutdown, spy restoration). Never use them for data setup.

```typescript
// Bad — mutable state, hidden setup
let files: TableHelper;
beforeEach(() => {
	const ws = createWorkspace({ id: 'test', tables: { files: filesTable } });
	files = ws.tables.files;
});

// Good — setup function, immutable per-test
function setup() {
	const ws = createWorkspace({ id: 'test', tables: { files: filesTable } });
	return { files: ws.tables.files };
}
```

## Shared Schemas at Module Level

Schemas and table definitions used across multiple tests should be defined at module level, outside `setup()`:

```typescript
const fileSchema = type({
	id: 'string',
	name: 'string',
	updatedAt: 'number',
	_v: '1',
});

const filesTable = defineTable(fileSchema);

function setup() {
	const ws = createWorkspace({ id: 'test', tables: { files: filesTable } });
	return { files: ws.tables.files };
}
```

These are stateless definitions — safe to share. Stateful objects (Y.Doc, workspace instances) go in `setup()`.

## Don't Return Dead Weight

Every property in the setup return should be used by at least one test. If no test uses `ydoc`, don't return it:

```typescript
// Bad — ydoc is never destructured by any test
function setup() {
	const ydoc = new Y.Doc();
	return { ydoc, tl: createTimeline(ydoc) };
}

// Good — only return what tests actually use
function setup() {
	return { tl: createTimeline(new Y.Doc()) };
}
```

Exception: if a value is needed for cleanup or might be needed by future tests in the same file, keeping it is fine.

## Test Structure

### Flat Over Nested

Prefer flat `test()` calls. Use `describe()` only to group genuinely distinct behavioral categories of the same unit:

```typescript
// Good — describe groups behaviors, tests are flat within
describe('FileTree', () => {
	describe('create', () => {
		test('creates file at root', () => { ... });
		test('rejects invalid names', () => { ... });
	});

	describe('move', () => {
		test('renames file', () => { ... });
		test('moves to different parent', () => { ... });
	});
});
```

```typescript
// Bad — unnecessary nesting
describe('FileTree', () => {
	describe('create', () => {
		describe('when the name is valid', () => {
			describe('and the parent exists', () => {
				test('creates the file', () => { ... });
			});
		});
	});
});
```

### Helper Functions Over Nesting

When tests need different setup scenarios, use named setup variants (not nested `describe` + `beforeEach`):

```typescript
// Good — composable setup functions
function setupWithFiles() {
	const { files } = setup();
	files.set(makeRow('f1', 'test.txt'));
	files.set(makeRow('f2', 'other.txt'));
	return { files };
}

test('lists all files', () => {
	const { files } = setupWithFiles();
	expect(files.count()).toBe(2);
});
```

## References

- Kent C. Dodds, ["Avoid Nesting When You're Testing"](https://kentcdodds.com/blog/avoid-nesting-when-youre-testing) — setup functions over beforeEach, flat tests
- Kent C. Dodds, ["AHA Testing"](https://kentcdodds.com/blog/aha-testing) — avoid hasty abstractions in tests
- Kent C. Dodds, [Testing JavaScript](https://testingjavascript.com) — Test Object Factory Pattern
- Matt Pocock, ["How to test your types"](https://www.totaltypescript.com/how-to-test-your-types) — vitest `expectTypeOf` for type testing
- Matt Pocock, [`shoehorn`](https://github.com/total-typescript/shoehorn) — partial mocks for test ergonomics
